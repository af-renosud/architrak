// Task #231 — overlap & supersession detection orchestrator.
//
// A per-project background reconciliation pass that detects dangerous
// document relationships — above all a consolidated devis that has
// silently absorbed earlier individual devis (double-counting). It is
// layered:
//   1. canonical scope-line model (scope-lines.ts)
//   2. semantic candidate matching   (embeddings.ts + pgvector)
//   3. deterministic arithmetic screening (subset-sum.ts)
//   4. Gemini reasoning with citations (reasoning.ts)
//   5. arithmetic proof + verdict (proven | needs_review)
//   6. idempotent persistence of structured "overlap cases"
//
// Critically, it changes NO financial total and fires NO user-facing
// alert — those are downstream tasks. Persistence is idempotent: cases
// are keyed by a stable hash so re-runs upsert in place and withdraw any
// case the latest run no longer detects. Without GEMINI_API_KEY the
// engine degrades gracefully to deterministic arithmetic-only detection.

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import { overlapCases, type OverlapRelationshipType, type OverlapDetectionSource, type OverlapVerdict } from "@shared/schema";
import { buildDevisScope, type DevisScope } from "./scope-lines";
import { ensureScopeEmbeddings, isAiAvailable } from "./embeddings";
import { findSubsetSums, type SubsetCandidate } from "./subset-sum";
import { classifyRelationship } from "./reasoning";

export interface ReconciliationSummary {
  projectId: number;
  devisConsidered: number;
  aiUsed: boolean;
  detected: number;
  proven: number;
  needsReview: number;
  withdrawn: number;
}

// Cosine-distance ceiling for a semantic neighbour to be worth examining
// (0 = identical, 1 = orthogonal). 0.25 keeps only strongly-similar devis.
const SEMANTIC_MAX_DISTANCE = 0.25;
const SEMANTIC_NEIGHBOURS = 5;

interface CandidateGroup {
  primaryDevisId: number;
  memberDevisIds: number[]; // sorted ascending
  sources: Set<"arithmetic" | "semantic">;
}

interface StoredCitation {
  devisId: number;
  devisCode: string | null;
  lineNumber: number | null;
  description: string;
  totalHt: string | null;
}

interface DesiredCase {
  caseKey: string;
  relationshipType: OverlapRelationshipType;
  primaryDevisId: number;
  memberDevisIds: number[];
  detectionSource: OverlapDetectionSource;
  confidence: number;
  verdict: OverlapVerdict;
  arithmeticProof: { primaryCents: number; memberCents: number[]; sumCents: number; deltaCents: number; reconciles: boolean };
  citations: StoredCitation[];
  reasoning: string | null;
}

/** Stable identity hash for an overlap case. Exported for testing. */
export function computeCaseKey(args: {
  projectId: number;
  relationshipType: string;
  primaryDevisId: number;
  memberDevisIds: number[];
}): string {
  const members = [...args.memberDevisIds].sort((a, b) => a - b).join(",");
  return createHash("sha256")
    .update(`${args.projectId}|${args.relationshipType}|${args.primaryDevisId}|${members}`)
    .digest("hex");
}

function groupKey(primaryDevisId: number, memberDevisIds: number[]): string {
  return `${primaryDevisId}|${[...memberDevisIds].sort((a, b) => a - b).join(",")}`;
}

/** Build deterministic arithmetic candidate groups via subset-sum. */
function arithmeticCandidates(scopes: DevisScope[]): Map<string, CandidateGroup> {
  const groups = new Map<string, CandidateGroup>();
  for (const primary of scopes) {
    if (primary.totalCents <= 0) continue;
    const pool: SubsetCandidate[] = scopes
      .filter((s) => s.devisId !== primary.devisId && s.totalCents > 0 && s.totalCents < primary.totalCents)
      .map((s) => ({ devisId: s.devisId, cents: s.totalCents }));
    if (pool.length < 2) continue;
    // Tolerance scales with member count to absorb per-line 2-decimal
    // rounding drift across the absorbed devis.
    const matches = findSubsetSums(primary.totalCents, pool, { toleranceCents: 0 });
    const tolerant = matches.length > 0
      ? matches
      : findSubsetSums(primary.totalCents, pool, { toleranceCents: 5 });
    for (const m of tolerant) {
      const key = groupKey(primary.devisId, m.memberDevisIds);
      const existing = groups.get(key);
      if (existing) {
        existing.sources.add("arithmetic");
      } else {
        groups.set(key, {
          primaryDevisId: primary.devisId,
          memberDevisIds: m.memberDevisIds,
          sources: new Set<"arithmetic" | "semantic">(["arithmetic"]),
        });
      }
    }
  }
  return groups;
}

/**
 * Build semantic candidate pairs from pgvector neighbours. Each pair is
 * directed: the larger-total devis is the primary (the potential
 * consolidator / superseder). Requires embeddings (AI available).
 */
async function semanticCandidates(projectId: number, scopes: DevisScope[]): Promise<Map<string, CandidateGroup>> {
  const groups = new Map<string, CandidateGroup>();
  const byId = new Map(scopes.map((s) => [s.devisId, s]));
  for (const scope of scopes) {
    const neighbours = await storage.findSimilarProjectDevis({
      projectId,
      devisId: scope.devisId,
      limit: SEMANTIC_NEIGHBOURS,
      maxDistance: SEMANTIC_MAX_DISTANCE,
    });
    for (const n of neighbours) {
      const other = byId.get(n.devisId);
      if (!other) continue;
      // Direct the pair: bigger total is primary; tie-break on higher id
      // so each unordered pair yields exactly one directed candidate.
      const primaryIsScope = scope.totalCents > other.totalCents
        || (scope.totalCents === other.totalCents && scope.devisId > other.devisId);
      const primaryDevisId = primaryIsScope ? scope.devisId : other.devisId;
      const memberDevisIds = [primaryIsScope ? other.devisId : scope.devisId];
      const key = groupKey(primaryDevisId, memberDevisIds);
      const existing = groups.get(key);
      if (existing) {
        existing.sources.add("semantic");
      } else {
        groups.set(key, { primaryDevisId, memberDevisIds, sources: new Set<"arithmetic" | "semantic">(["semantic"]) });
      }
    }
  }
  return groups;
}

function mergeGroups(
  ...maps: Array<Map<string, CandidateGroup>>
): CandidateGroup[] {
  const merged = new Map<string, CandidateGroup>();
  for (const map of maps) {
    for (const [key, group] of Array.from(map)) {
      const existing = merged.get(key);
      if (existing) {
        Array.from(group.sources).forEach((s) => existing.sources.add(s));
      } else {
        merged.set(key, { ...group, sources: new Set<"arithmetic" | "semantic">(group.sources) });
      }
    }
  }
  return Array.from(merged.values());
}

function detectionSourceOf(sources: Set<"arithmetic" | "semantic">): OverlapDetectionSource {
  const hasArith = sources.has("arithmetic");
  const hasSem = sources.has("semantic");
  if (hasArith && hasSem) return "both";
  return hasArith ? "arithmetic" : "semantic";
}

function summaryCitation(scope: DevisScope): StoredCitation {
  const desc = scope.descriptionFr.length > 160 ? `${scope.descriptionFr.slice(0, 157)}…` : scope.descriptionFr;
  return {
    devisId: scope.devisId,
    devisCode: scope.devisCode,
    lineNumber: null,
    description: `${scope.devisCode ?? `devis ${scope.devisId}`}: ${desc}`,
    totalHt: (scope.totalCents / 100).toFixed(2),
  };
}

/**
 * Run the reconciliation pass for one project. Idempotent: safe to call
 * repeatedly; it upserts detected cases by stable key and withdraws cases
 * no longer present. Returns a summary of what changed.
 */
export async function runProjectReconciliation(projectId: number): Promise<ReconciliationSummary> {
  const allDevis = (await storage.getDevisByProject(projectId)).filter((d) => d.status !== "void");
  const scopes: DevisScope[] = [];
  for (const d of allDevis) {
    const lines = await storage.getDevisLineItems(d.id);
    scopes.push(buildDevisScope(d, lines));
  }
  const byId = new Map(scopes.map((s) => [s.devisId, s]));

  const aiAvailable = isAiAvailable();
  if (aiAvailable) {
    await ensureScopeEmbeddings(projectId, scopes);
  }

  // Candidate generation. Arithmetic is always available; semantic only
  // when embeddings exist.
  const arithMap = arithmeticCandidates(scopes);
  const semMap = aiAvailable ? await semanticCandidates(projectId, scopes) : new Map<string, CandidateGroup>();
  const candidates = mergeGroups(arithMap, semMap);

  const desired = new Map<string, DesiredCase>();

  for (const group of candidates) {
    const primary = byId.get(group.primaryDevisId);
    if (!primary) continue;
    const members = group.memberDevisIds.map((id) => byId.get(id)).filter((s): s is DevisScope => Boolean(s));
    if (members.length === 0) continue;

    const memberCents = members.map((m) => m.totalCents);
    const sumCents = memberCents.reduce((a, b) => a + b, 0);
    const deltaCents = sumCents - primary.totalCents;
    const reconciles = Math.abs(deltaCents) <= Math.max(0, members.length);
    const arithmeticProof = { primaryCents: primary.totalCents, memberCents, sumCents, deltaCents, reconciles };

    let relationshipType: OverlapRelationshipType;
    let confidence: number;
    let reasoning: string | null;
    let citations: StoredCitation[];

    if (aiAvailable) {
      const verdictAi = await classifyRelationship(primary, members);
      if (verdictAi === null) {
        // AI errored or returned unusable output. Within this branch the API
        // key and members are both present (see isAiAvailable + the
        // members.length guard above), so null is NEVER "AI disabled" — it is
        // a transient model/parse failure for THIS candidate. Degrade to the
        // deterministic arithmetic verdict rather than silently dropping the
        // candidate, otherwise a model outage would suppress an
        // arithmetically-strong overlap (the exact double-counting risk this
        // engine exists to catch). Non-arithmetic / non-reconciling candidates
        // have no deterministic basis, so those are skipped.
        if (!group.sources.has("arithmetic") || !reconciles) continue;
        relationshipType = "aggregates";
        confidence = 0.85;
        reasoning = "Arithmetic match: member devis totals sum exactly to the primary devis total (AI reasoning unavailable for this run).";
        citations = [primary, ...members].map(summaryCitation);
      } else if (verdictAi.relationshipType === "unrelated") {
        // Model explicitly judged the match coincidental — do not persist noise.
        continue;
      } else {
        relationshipType = verdictAi.relationshipType;
        confidence = verdictAi.confidence;
        reasoning = verdictAi.reasoning || null;
        citations = verdictAi.citations.length > 0
          ? verdictAi.citations.map((c) => {
              const scope = byId.get(c.devisId);
              const line = c.lineNumber != null ? scope?.lines.find((l) => l.lineNumber === c.lineNumber) : undefined;
              return {
                devisId: c.devisId,
                devisCode: scope?.devisCode ?? null,
                lineNumber: c.lineNumber,
                description: c.description,
                totalHt: line ? (line.totalCents / 100).toFixed(2) : null,
              };
            })
          : [primary, ...members].map(summaryCitation);
      }
    } else {
      // Deterministic path: only arithmetically-reconciling aggregations
      // survive without a model to disambiguate intent.
      if (!group.sources.has("arithmetic") || !reconciles) continue;
      relationshipType = "aggregates";
      confidence = 0.85;
      reasoning = "Arithmetic match: member devis totals sum exactly to the primary devis total (no AI reasoning available).";
      citations = [primary, ...members].map(summaryCitation);
    }

    const verdict: OverlapVerdict = reconciles ? "proven" : "needs_review";
    const caseKey = computeCaseKey({
      projectId,
      relationshipType,
      primaryDevisId: primary.devisId,
      memberDevisIds: group.memberDevisIds,
    });
    if (desired.has(caseKey)) continue;
    desired.set(caseKey, {
      caseKey,
      relationshipType,
      primaryDevisId: primary.devisId,
      memberDevisIds: group.memberDevisIds,
      detectionSource: detectionSourceOf(group.sources),
      confidence,
      verdict,
      arithmeticProof,
      citations,
      reasoning,
    });
  }

  // Idempotent persistence: upsert desired cases by caseKey; withdraw any
  // currently-active case the latest run no longer detects.
  let proven = 0;
  let needsReview = 0;
  let withdrawn = 0;
  const now = new Date();

  await db.transaction(async (tx) => {
    const existingActive = await tx
      .select({ id: overlapCases.id, caseKey: overlapCases.caseKey })
      .from(overlapCases)
      .where(and(eq(overlapCases.projectId, projectId), eq(overlapCases.status, "active")));

    for (const c of Array.from(desired.values())) {
      if (c.verdict === "proven") proven++; else needsReview++;
      await tx
        .insert(overlapCases)
        .values({
          projectId,
          caseKey: c.caseKey,
          relationshipType: c.relationshipType,
          primaryDevisId: c.primaryDevisId,
          memberDevisIds: c.memberDevisIds,
          detectionSource: c.detectionSource,
          confidence: c.confidence.toFixed(3),
          verdict: c.verdict,
          arithmeticProof: c.arithmeticProof,
          citations: c.citations,
          reasoning: c.reasoning,
          status: "active",
        })
        .onConflictDoUpdate({
          target: [overlapCases.caseKey],
          set: {
            memberDevisIds: c.memberDevisIds,
            detectionSource: c.detectionSource,
            confidence: c.confidence.toFixed(3),
            verdict: c.verdict,
            arithmeticProof: c.arithmeticProof,
            citations: c.citations,
            reasoning: c.reasoning,
            status: "active",
            withdrawnAt: null,
            lastSeenAt: now,
            updatedAt: now,
          },
        });
    }

    const desiredKeys = new Set(desired.keys());
    for (const row of existingActive) {
      if (desiredKeys.has(row.caseKey)) continue;
      await tx
        .update(overlapCases)
        .set({ status: "withdrawn", withdrawnAt: now, updatedAt: now })
        .where(eq(overlapCases.id, row.id));
      withdrawn++;
    }
  });

  return {
    projectId,
    devisConsidered: scopes.length,
    aiUsed: aiAvailable,
    detected: desired.size,
    proven,
    needsReview,
    withdrawn,
  };
}
