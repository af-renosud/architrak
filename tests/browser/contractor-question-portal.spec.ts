import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";

/**
 * E2E coverage for the contractor question portal flow (task #83).
 *
 * Requires the dev server with:
 *   - NODE_ENV=development
 *   - ENABLE_DEV_LOGIN_FOR_E2E=true   (so POST /api/auth/dev-login is registered)
 *   - E2E_FAKE_GMAIL=true             (so server/gmail/client.ts returns a fake
 *                                      send client and never hits real Gmail)
 *   - PUBLIC_BASE_URL=<base_url>      (must match playwright's BASE_URL so the
 *                                      portal link in the email points to the
 *                                      same origin we're testing against)
 *
 * Covers:
 *   - Architect flags a line item red -> auto-create check (open).
 *   - Bundled send -> check flips to awaiting_contractor.
 *   - Idempotent re-send: clicking Send twice with no new messages reuses
 *     the prior bundle (no duplicate Gmail send, no duplicate audit row).
 *   - Sign-off-stage gate: trying to advance signOffStage to 'sent_to_client'
 *     while the check is open returns 409 with a French/error message.
 *   - Contractor opens the portal link, sees the question in French, posts
 *     a reply -> check flips to awaiting_architect.
 *   - Architect resolves the check via the UI -> status 'resolved', sign-off
 *     gate now allows advance to 'sent_to_client'.
 */

interface Seed {
  projectId: number;
  contractorId: number;
  devisId: number;
  lineItemId: number;
  uniq: string;
}

async function devLogin(api: APIRequestContext, email: string) {
  const res = await api.post("/api/auth/dev-login", { data: { email } });
  expect(
    res.ok(),
    `dev-login failed (${res.status()}). Is ENABLE_DEV_LOGIN_FOR_E2E=true?`,
  ).toBe(true);
}

async function postOk<T = unknown>(api: APIRequestContext, url: string, body: unknown): Promise<T> {
  const res = await api.post(url, { data: body });
  expect(res.ok(), `POST ${url} failed: ${res.status()} ${await safeText(res)}`).toBe(true);
  return (await res.json()) as T;
}

async function patchOk<T = unknown>(api: APIRequestContext, url: string, body: unknown): Promise<T> {
  const res = await api.patch(url, { data: body });
  expect(res.ok(), `PATCH ${url} failed: ${res.status()} ${await safeText(res)}`).toBe(true);
  return (await res.json()) as T;
}

async function safeText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}

async function seed(api: APIRequestContext, uniq: string, contractorEmail: string): Promise<Seed> {
  const project = await postOk<{ id: number }>(api, "/api/projects", {
    name: `ChecksPortal Test ${uniq}`,
    code: `CP-${uniq}`,
    clientName: "Test Client",
  });
  const contractor = await postOk<{ id: number }>(api, "/api/contractors", {
    name: `Checks Portal Co ${uniq}`,
    email: contractorEmail,
  });
  const devis = await postOk<{ id: number }>(api, `/api/projects/${project.id}/devis`, {
    contractorId: contractor.id,
    devisCode: `DEV-${uniq}`,
    descriptionFr: "Devis pour le test du portail de questions",
    amountHt: "1000.00",
    amountTtc: "1200.00",
    invoicingMode: "mode_b",
  });
  const lineItem = await postOk<{ id: number }>(api, `/api/devis/${devis.id}/line-items`, {
    lineNumber: 1,
    description: "Pose de chaudière à condensation",
    quantity: "1",
    unit: "u",
    unitPriceHt: "1000.00",
    totalHt: "1000.00",
  });
  return {
    projectId: project.id,
    contractorId: contractor.id,
    devisId: devis.id,
    lineItemId: lineItem.id,
    uniq,
  };
}

interface CheckRow {
  id: number;
  status: "open" | "awaiting_contractor" | "awaiting_architect" | "resolved" | "dropped";
  query: string;
  origin: string;
  lineItemId: number | null;
}

async function listChecks(api: APIRequestContext, devisId: number): Promise<CheckRow[]> {
  const res = await api.get(`/api/devis/${devisId}/checks`);
  expect(res.ok(), `GET checks failed: ${res.status()}`).toBe(true);
  return (await res.json()) as CheckRow[];
}

interface BundledSendResponse {
  communicationId: number;
  reused: boolean;
  checksSent: number;
  portalUrl?: string;
}

async function captureBundleSend(
  context: BrowserContext,
  page: import("@playwright/test").Page,
  trigger: () => Promise<void>,
): Promise<BundledSendResponse> {
  const responsePromise = page.waitForResponse(
    (r) => /\/api\/devis\/\d+\/checks\/send$/.test(r.url()) && r.request().method() === "POST",
  );
  await trigger();
  const res = await responsePromise;
  expect(res.ok(), `bundled send failed: ${res.status()}`).toBe(true);
  return (await res.json()) as BundledSendResponse;
}

test.describe("Contractor question portal — end-to-end", () => {
  test("flag → send (idempotent) → portal reply → resolve, with sign-off gate", async ({ browser }) => {
    const uniq = `e2e${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const architectEmail = `e2e-architect-${uniq}@local.test`;
    const contractorEmail = `e2e-contractor-${uniq}@local.test`;

    const archCtx = await browser.newContext();
    try {
      await devLogin(archCtx.request, architectEmail);
      const data = await seed(archCtx.request, uniq, contractorEmail);

      const page = await archCtx.newPage();
      await page.goto(`/projets/${data.projectId}`);
      await page.getByTestId("tab-devis").click();
      await page.getByTestId(`row-devis-toggle-${data.devisId}`).click();

      // -------- 1. Architect flags the line item RED → auto-create check.
      await page.getByTestId(`button-check-red-${data.lineItemId}`).click();

      // The PATCH that flips the line-item status auto-creates a check on
      // the server, but the line-item mutation only invalidates the
      // line-items query — not the checks query. Reload to refetch the
      // checks panel so the architect-side UI reflects the new check.
      await expect
        .poll(async () => (await listChecks(archCtx.request, data.devisId)).length, { timeout: 10_000 })
        .toBe(1);
      const checksAfterFlag = await listChecks(archCtx.request, data.devisId);
      expect(checksAfterFlag[0].origin).toBe("line_item");
      expect(checksAfterFlag[0].lineItemId).toBe(data.lineItemId);
      expect(checksAfterFlag[0].status).toBe("open");
      const checkId = checksAfterFlag[0].id;

      await page.reload();
      await page.getByTestId("tab-devis").click();
      await page.getByTestId(`row-devis-toggle-${data.devisId}`).click();
      await expect(page.getByTestId(`section-checks-${data.devisId}`)).toBeVisible();
      await expect(page.getByTestId(`text-open-checks-count-${data.devisId}`)).toContainText(
        "1 question",
      );

      // -------- 2. Sign-off gate: cannot advance to sent_to_client while open.
      const blocked = await archCtx.request.patch(`/api/devis/${data.devisId}`, {
        data: { signOffStage: "sent_to_client" },
      });
      expect(blocked.status()).toBe(409);
      const blockedBody = (await blocked.json()) as { message: string; openChecks?: number };
      // The error MUST be French (architect-facing UI is FR-only).
      expect(blockedBody.message).toContain("Impossible d'envoyer le devis au client");
      expect(blockedBody.message).toContain("1 question contractant");
      expect(blockedBody.openChecks).toBe(1);

      // -------- 3. First bundled send via the UI → captures portal URL.
      const sendBtn = page.getByTestId(`button-send-checks-${data.devisId}`);
      await expect(sendBtn).toBeEnabled();
      const firstSend = await captureBundleSend(archCtx, page, async () => {
        await sendBtn.click();
      });
      expect(firstSend.reused).toBe(false);
      expect(firstSend.checksSent).toBe(1);
      const portalUrl = firstSend.portalUrl;
      expect(portalUrl, "first send should return a fresh portal URL").toBeTruthy();

      // Toast confirms send (French copy).
      await expect(page.getByText("Email envoyé", { exact: true })).toBeVisible({ timeout: 5_000 });

      // Check status flips to awaiting_contractor.
      await expect
        .poll(async () => (await listChecks(archCtx.request, data.devisId))[0].status, { timeout: 5_000 })
        .toBe("awaiting_contractor");

      // -------- 4. Idempotent re-send: clicking Send again with no new
      // messages reuses the prior bundle (reused=true, no extra Gmail send).
      await expect(sendBtn).toBeEnabled();
      const secondSend = await captureBundleSend(archCtx, page, async () => {
        await sendBtn.click();
      });
      expect(secondSend.reused).toBe(true);
      expect(secondSend.communicationId).toBe(firstSend.communicationId);
      // Toast confirms the no-op (French copy: "Email déjà envoyé").
      await expect(page.getByText("Email déjà envoyé", { exact: true })).toBeVisible({
        timeout: 5_000,
      });

      // -------- 5. Contractor opens portal in a fresh, anonymous context.
      const portalPath = new URL(portalUrl!).pathname; // /p/check/<raw>
      const contractorCtx = await browser.newContext();
      try {
        const contractorPage = await contractorCtx.newPage();
        await contractorPage.goto(portalPath);

        // French shell rendered.
        await expect(contractorPage.locator("header h1")).toHaveText(
          "Espace contractant — Renosud",
        );
        const pdfToggle = contractorPage.getByTestId("button-pdf-toggle");
        await expect(pdfToggle).toHaveText("Voir le devis (PDF)");

        // Floating PDF panel is hidden by default and opens on toggle.
        const pdfPanel = contractorPage.locator("#pdfPanel");
        await expect(pdfPanel).toBeHidden();
        await pdfToggle.click();
        await expect(pdfPanel).toBeVisible();
        await expect(pdfPanel).toHaveClass(/\bopen\b/);
        // Iframe is wired to the per-token PDF endpoint (not still about:blank).
        const iframe = pdfPanel.locator("#pdfFrame");
        await expect(iframe).toHaveAttribute("src", /\/p\/check\/[^/]+\/pdf$/);
        // Close it before continuing so it doesn't cover the reply form.
        await contractorPage.locator("#pdfClose").click();
        await expect(pdfPanel).toBeHidden();

        // The single open question is rendered with a reply form.
        const replyTextarea = contractorPage.getByTestId(`textarea-reply-${checkId}`);
        await expect(replyTextarea).toBeVisible({ timeout: 10_000 });
        const replyBody = `Réponse contractant ${uniq}`;
        await replyTextarea.fill(replyBody);
        await contractorPage.getByTestId(`button-send-reply-${checkId}`).click();

        // Reply is rendered back into the thread.
        await expect(contractorPage.locator(".msg-contractor").first()).toContainText(replyBody, {
          timeout: 5_000,
        });
      } finally {
        await contractorCtx.close();
      }

      // -------- 6. Server confirms the contractor reply flipped the status.
      await expect
        .poll(async () => (await listChecks(archCtx.request, data.devisId))[0].status, { timeout: 5_000 })
        .toBe("awaiting_architect");

      // -------- 7. Architect resolves the check via the UI.
      // The architect-side panel needs to refetch — refresh the row so the
      // resolve button (only shown for awaiting_architect) appears.
      await page.reload();
      await page.getByTestId("tab-devis").click();
      await page.getByTestId(`row-devis-toggle-${data.devisId}`).click();
      const resolveBtn = page.getByTestId(`button-resolve-check-${checkId}`);
      await expect(resolveBtn).toBeVisible({ timeout: 10_000 });
      await resolveBtn.click();
      await expect(page.getByText("Question clôturée", { exact: true })).toBeVisible({
        timeout: 5_000,
      });

      await expect
        .poll(async () => (await listChecks(archCtx.request, data.devisId))[0].status, { timeout: 5_000 })
        .toBe("resolved");

      // -------- 8. Sign-off gate now lets the architect advance the stage.
      const okAdvance = await archCtx.request.patch(`/api/devis/${data.devisId}`, {
        data: { signOffStage: "sent_to_client" },
      });
      expect(okAdvance.ok(), `advance to sent_to_client should now succeed: ${okAdvance.status()}`).toBe(
        true,
      );
    } finally {
      await archCtx.close();
    }
  });
});
