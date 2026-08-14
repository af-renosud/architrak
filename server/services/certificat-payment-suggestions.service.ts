import { storage } from "../storage";
import { reconcilePayments } from "./certificat-payments.service";
import type { gmail_v1 } from "googleapis";

/**
 * Task #466 — detect client "paid" confirmation replies on the Gmail
 * threads of sent certificats and turn them into DRAFT payment suggestions.
 *
 * Deterministic by design (mirrors the email-prefilter philosophy): no AI —
 * a reply only becomes a suggestion when (a) it arrived on the exact thread
 * we sent the certificat from (thread id persisted on the
 * project_communications row at send time), (b) the sender is the client
 * that certificat was addressed to, and (c) the text matches a closed set
 * of payment-confirmation phrases. A client reply on the thread that does
 * NOT match lands as an `ambiguous` row in the communications hub instead
 * of being silently dropped. Nothing is ever auto-recorded — the architect
 * confirms (source='email' ledger entry via the atomic tx) or dismisses.
 *
 * Idempotency: one suggestion per inbound Gmail message id (unique), and
 * at most one open pending suggestion per certificat (partial unique
 * index) — duplicate "paid" replies never stack for the same outstanding
 * balance.
 */

// Closed phrase set — past-tense payment confirmations in FR + EN. Kept
// intentionally strict: "je vais payer" / "payment next week" must NOT match.
// NOTE: JS `\b` treats accented letters as non-word chars, so "payé\b"
// never matches — and the `u` regex flag is rejected by the project's TS
// target (TS1501). Use an explicit Latin-letter class as the boundary
// instead: a match must not be preceded/followed by a letter.
const L = "a-zA-Z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF"; // Latin letters incl. accents
const B = `(?:^|[^${L}])`; // start boundary (may consume one non-letter char)
const E = `(?![${L}])`; // end boundary (lookahead, consumes nothing)
const PAID_PATTERNS: RegExp[] = [
  `pay[ée]e?s?`,                                   // payé / payée / payés
  `r[ée]gl[ée]e?s?`,                               // réglé / reglee…
  `r[èe]glement\\s+(?:effectu[ée]|fait|envoy[ée])`,// règlement effectué
  `virement\\s+(?:effectu[ée]|fait|envoy[ée]|parti|[ée]mis)`,
  `vir[ée]\\s+ce\\s+jour`,
  `paid`,
  `payment\\s+(?:sent|made|done|completed|processed)`,
  `transfer\\s+(?:sent|made|completed)`,
].map((core) => new RegExp(`${B}(${core})${E}`, "i"));

export interface PaidDetection {
  matched: boolean;
  excerpt: string | null;
}

/** Trim quoted reply history so the ORIGINAL outbound email (which talks
 *  about payment) can never trigger a match against its own quote. */
export function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;                              // "> quoted"
    if (/^\s*Le .{4,80} a [ée]crit\s*:/.test(line)) break;      // FR Gmail quote header
    if (/^\s*On .{4,120} wrote\s*:/.test(line)) break;          // EN quote header
    if (/^-{2,}\s*(Original|Forwarded) message/i.test(line)) break;
    kept.push(line);
  }
  return kept.join("\n");
}

export function detectPaidConfirmation(rawText: string): PaidDetection {
  const text = stripQuotedReply(rawText);
  for (const re of PAID_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      // Group 1 is the phrase itself (group 0 may include the boundary char).
      const phraseStart = m.index + m[0].indexOf(m[1]);
      const start = Math.max(0, phraseStart - 60);
      const end = Math.min(text.length, phraseStart + m[1].length + 60);
      const excerpt = text.slice(start, end).replace(/\s+/g, " ").trim();
      return { matched: true, excerpt };
    }
  }
  return { matched: false, excerpt: null };
}

/** Extract the bare address from a From header ("Name <a@b.c>" → a@b.c). */
export function extractAddress(fromHeader: string): string {
  const m = fromHeader.match(/<([^>]+)>/);
  return (m ? m[1] : fromHeader).trim().toLowerCase();
}

function headerOf(msg: gmail_v1.Schema$Message, name: string): string {
  return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

/** Best-effort plain-text body: prefer text/plain parts, fall back to the
 *  Gmail snippet. Attachments are never parsed (out of scope). */
export function extractPlainText(msg: gmail_v1.Schema$Message): string {
  const chunks: string[] = [];
  const walk = (part: gmail_v1.Schema$MessagePart | undefined) => {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data) chunks.push(decodeBase64Url(part.body.data));
    for (const child of part.parts ?? []) walk(child);
  };
  walk(msg.payload);
  if (chunks.length > 0) return chunks.join("\n");
  return msg.snippet ?? "";
}

export interface ReplyScanResult {
  scannedThreads: number;
  suggestionsCreated: number;
  ambiguousCreated: number;
  errors: number;
  /** The mailbox refused thread reads (403) — the whole pass is useless
   * with this client, so the scan aborts after the first denial. Set on
   * the connector pass when the Replit connector lacks a read scope. */
  scopeDenied?: boolean;
}

/**
 * Scan the threads of sent certificats (certificat not yet paid/superseded)
 * for client replies. Called from the Gmail monitor with a read-scoped
 * per-user client. Safe to re-run: already-seen message ids are skipped.
 */
export async function scanCertificatReplies(gmail: gmail_v1.Gmail, scope?: number | "unowned"): Promise<ReplyScanResult> {
  const result: ReplyScanResult = { scannedThreads: 0, suggestionsCreated: 0, ambiguousCreated: 0, errors: 0 };
  // scope = user id → threads that user's mailbox sent, plus legacy
  // connector sends (probed: threads.get 404 = not-my-mailbox, skipped
  // below). scope = "unowned" → connector pass over legacy sends only.
  const awaiting = await storage.getCertificatCommunicationsAwaitingPayment(scope);

  for (const { communication: comm, cert } of awaiting) {
    if (!comm.emailThreadId) continue;
    try {
      result.scannedThreads++;
      let thread;
      try {
        thread = await gmail.users.threads.get({ userId: "me", id: comm.emailThreadId, format: "full" });
      } catch (err: any) {
        // 404 = this thread does not exist in THIS mailbox. The monitor runs
        // the scan once per linked inbox; only the mailbox that actually owns
        // the thread can read it, so a miss here is expected, not an error.
        if (err?.status === 404 || err?.code === 404 || err?.response?.status === 404) continue;
        // 403 = this client cannot read threads AT ALL (e.g. the Replit
        // connector has send-only scopes). Every remaining thread would
        // fail identically — abort the pass and tell the caller.
        if (err?.status === 403 || err?.code === 403 || err?.response?.status === 403) {
          result.errors++;
          result.scopeDenied = true;
          console.error(`[PaymentSuggestions] mailbox denied thread reads (403) — aborting this scan pass (communication ${comm.id})`);
          return result;
        }
        throw err;
      }
      const messages = thread.data.messages ?? [];
      if (messages.length === 0) continue;

      const clientAddress = (comm.recipientEmail ?? "").trim().toLowerCase();
      if (!clientAddress) continue;

      for (const msg of messages) {
        const messageId = msg.id;
        if (!messageId || messageId === comm.emailMessageId) continue;
        const sender = extractAddress(headerOf(msg, "From"));
        // Only the client on THIS thread can confirm payment — our own
        // follow-ups and third parties are skipped.
        if (sender !== clientAddress) continue;
        if (await storage.getPaymentSuggestionByEmailMessageId(messageId)) continue;

        const payments = await storage.getCertificatPayments(cert.id);
        const state = reconcilePayments(cert, payments);
        // Fully covered — nothing left to suggest for.
        if (state.fullyPaid || state.outstanding <= 0) continue;

        const detection = detectPaidConfirmation(extractPlainText(msg));
        const emailDate = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date();
        const created = await storage.createCertificatPaymentSuggestion({
          certificatId: cert.id,
          projectId: cert.projectId,
          communicationId: comm.id,
          emailMessageId: messageId,
          emailThreadId: comm.emailThreadId,
          senderEmail: sender,
          emailDate,
          matchedExcerpt: detection.excerpt,
          suggestedAmount: state.outstanding.toFixed(2),
          suggestedDate: emailDate.toISOString().slice(0, 10),
          status: detection.matched ? "pending_review" : "ambiguous",
        });
        if (created) {
          if (detection.matched) {
            result.suggestionsCreated++;
            console.log(
              `[PaymentSuggestions] cert ${cert.certificateRef}: "paid" reply from ${sender} → suggestion #${created.id} (${state.outstanding.toFixed(2)} € outstanding)`,
            );
          } else {
            result.ambiguousCreated++;
            console.log(`[PaymentSuggestions] cert ${cert.certificateRef}: ambiguous client reply from ${sender} parked for review`);
          }
        }
      }
    } catch (err) {
      result.errors++;
      console.error(`[PaymentSuggestions] thread scan failed for communication ${comm.id} (cert ${cert.certificateRef}):`, err);
    }
  }
  return result;
}
