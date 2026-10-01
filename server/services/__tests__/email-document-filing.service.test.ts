import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  devis, invoices, marcheDocuments, projectIntakeDocuments, projects, situations, type EmailDocument,
} from "@shared/schema";
import type { FilingIntakeSource, FilingTarget } from "@shared/email-document-filing";

const dbMock = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("../../db", () => ({ db: dbMock }));

import { enrichEmailDocumentsFromLookups, enrichEmailDocumentsWithFiling } from "../email-document-filing.service";

function email(id: number, overrides: Partial<EmailDocument> = {}): EmailDocument {
  return {
    id, projectId: 12, extractionStatus: "completed", intakeDeletedAt: null, notes: null,
    devisId: null, invoiceId: null, emailMessageId: `fixture-${id}`,
    ...overrides,
  } as EmailDocument;
}
function intake(emailId: number, overrides: Partial<FilingIntakeSource> = {}): FilingIntakeSource {
  return {
    id: emailId + 100, projectId: 12, sourceEmailDocumentId: emailId,
    analysisState: "analyzed", routingState: "unrouted",
    promotedKind: null, promotedId: null, notes: null,
    ...overrides,
  };
}
function target(id: number, intakeId: number, kind = "devis"): FilingTarget {
  return { id, kind, projectId: 12, sourceIntakeDocumentId: intakeId, isRemoved: false };
}

describe("batched email filing lookup fixtures", () => {
  it("enriches all states in one mixed list without altering source rows", () => {
    const documents = [
      email(1), email(2), email(3), email(4), email(5),
      email(6, { extractionStatus: "skipped" }), email(7, { devisId: 999 }),
      email(8, { projectId: 99 }), email(9), email(10),
    ];
    const sources = [
      intake(1, { analysisState: "analyzing" }),
      intake(2, { routingState: "parked", notes: "Choose the matching quotation." }),
      intake(3, { routingState: "routed", promotedKind: "devis", promotedId: 35 }),
      intake(4, { routingState: "duplicate", notes: "Duplicate of intake #79." }),
      intake(5, { analysisState: "failed", routingState: "failed", notes: "Analysis failed." }),
      intake(6, { routingState: "routed", promotedKind: "devis", promotedId: 36 }),
      intake(8, { routingState: "routed", promotedKind: "devis", promotedId: 38 }),
      intake(9, { routingState: "routed", promotedKind: "invoice", promotedId: 44 }),
      intake(10, { routingState: "routed", promotedKind: "devis", promotedId: 999 }),
    ];
    const before = JSON.stringify({ documents, sources });
    const result = enrichEmailDocumentsFromLookups(documents, {
      intakes: sources,
      projectIds: new Set([12, 99]),
      targets: [target(35, 103), target(36, 106), target(38, 108), target(44, 109, "invoice")],
    });
    expect(result.map((doc) => doc.filing.state)).toEqual([
      "processing", "needs_review", "filed", "duplicate", "failed", "removed",
      "not_filed", "mismatch", "filed", "mismatch",
    ]);
    expect(result[6].filing.destination).toBeNull(); // Legacy devisId is not authority.
    expect(result[7].filing).toMatchObject({
      projectId: 12, destination: { href: "/projets/12?tab=intake", label: "Open project intake" },
    });
    expect(result[8].filing.destination?.href).toBe("/projets/12?tab=factures&invoice=44");
    expect(result[9].filing.destination?.href).toBe("/projets/12?tab=intake");
    expect(result[5].filing.destination).toBeNull();
    expect(JSON.stringify({ documents, sources })).toBe(before);
  });

  it("looks up provenance by sourceEmailDocumentId, not email or intake array positions", () => {
    const result = enrichEmailDocumentsFromLookups([email(10), email(20)], {
      intakes: [intake(20, { routingState: "parked" }), intake(10, { analysisState: "analyzing" })],
      projectIds: new Set([12]),
      targets: [],
    });
    expect(result.map((doc) => [doc.id, doc.filing.intakeId, doc.filing.state]))
      .toEqual([[10, 110, "processing"], [20, 120, "needs_review"]]);
  });

  it("does not treat a wrong-project target or missing live project as filed", () => {
    const sources = [intake(1, { routingState: "routed", promotedKind: "devis", promotedId: 35 })];
    expect(enrichEmailDocumentsFromLookups([email(1)], {
      intakes: sources, projectIds: new Set([12, 99]), targets: [{ ...target(35, 101), projectId: 99 }],
    })[0].filing).toMatchObject({ state: "mismatch", destination: { href: "/projets/12?tab=intake" } });
    expect(enrichEmailDocumentsFromLookups([email(1)], {
      intakes: sources, projectIds: new Set(), targets: [target(35, 101)],
    })[0].filing).toMatchObject({ state: "mismatch", destination: null });
  });
});

describe("read-only database batching", () => {
  const rows = new Map<unknown, Record<string, unknown>[]>();
  const predicates: Array<{ table: string; params: unknown[]; fields: string[] }> = [];
  beforeEach(() => {
    vi.clearAllMocks();
    rows.clear();
    predicates.length = 0;
    dbMock.select.mockImplementation((fields: Record<string, unknown>) => ({
      from: (table: Parameters<typeof getTableName>[0]) => {
        const query = {
          innerJoin: vi.fn(() => query),
          where: (condition: SQL) => {
            predicates.push({
              table: getTableName(table), params: new PgDialect().sqlToQuery(condition).params,
              fields: Object.keys(fields),
            });
            return Promise.resolve((rows.get(table) ?? []).map((row) =>
              Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]]))));
          },
        };
        return query;
      },
    }));
  });

  it("empty lists need no database queries", async () => {
    expect(await enrichEmailDocumentsWithFiling([])).toEqual([]);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it("batches many rows in three SELECTs and deduplicates target/project ids", async () => {
    const documents = Array.from({ length: 40 }, (_, index) => email(index + 1));
    rows.set(projectIntakeDocuments, documents.map((doc) => ({
      ...intake(doc.id), routingState: "routed", promotedKind: "devis", promotedId: 35,
    })));
    rows.set(projects, [{ id: 12 }]);
    // Null provenance is valid for legacy records; all lookups use one id.
    rows.set(devis, [{ id: 35, projectId: 12, sourceIntakeDocumentId: null, status: "received" }]);

    const result = await enrichEmailDocumentsWithFiling(documents);
    expect(result).toHaveLength(40);
    expect(result.every((doc) => doc.filing.state === "filed")).toBe(true);
    expect(dbMock.select).toHaveBeenCalledTimes(3);
    expect(predicates.find((query) => query.table === "project_intake_documents")?.params)
      .toEqual(documents.map((doc) => doc.id));
    expect(predicates.find((query) => query.table === "projects")?.params).toEqual([12]);
    expect(predicates.find((query) => query.table === "devis")?.params).toEqual([35]);
    expect(predicates.map((query) => query.table).sort()).toEqual(["devis", "project_intake_documents", "projects"]);
  });

  it("uses real projections for all supported target tables, including situation parent project", async () => {
    const documents = [email(1), email(2), email(3), email(4)];
    rows.set(projectIntakeDocuments, documents.map((doc, index) => ({
      ...intake(doc.id), routingState: "routed",
      promotedKind: ["devis", "invoice", "situation", "marche_document"][index], promotedId: index + 31,
    })));
    rows.set(projects, [{ id: 12 }]);
    rows.set(devis, [{ id: 31, projectId: 12, sourceIntakeDocumentId: 101, status: "draft" }]);
    rows.set(invoices, [{ id: 32, projectId: 12, sourceIntakeDocumentId: 102, status: "pending" }]);
    rows.set(situations, [{ id: 33, projectId: 12, sourceIntakeDocumentId: 103, status: "draft", devisStatus: "received" }]);
    rows.set(marcheDocuments, [{ id: 34, projectId: 12, sourceIntakeDocumentId: 104, status: "draft" }]);
    const result = await enrichEmailDocumentsWithFiling(documents);
    expect(result.map((doc) => doc.filing.state)).toEqual(["filed", "filed", "filed", "filed"]);
    expect(result[1].filing.destination?.href).toBe("/projets/12?tab=factures&invoice=32");
    expect(dbMock.select).toHaveBeenCalledTimes(6);
    expect(predicates.find((query) => query.table === "situations")?.fields).toContain("devisStatus");
    expect(predicates.find((query) => query.table === "invoices")?.params).toEqual([32]);
  });

  it("void status from the actual target removes its action", async () => {
    rows.set(projectIntakeDocuments, [{
      ...intake(1), routingState: "routed", promotedKind: "devis", promotedId: 35,
    }]);
    rows.set(projects, [{ id: 12 }]);
    rows.set(devis, [{ id: 35, projectId: 12, sourceIntakeDocumentId: 101, status: "void" }]);
    expect((await enrichEmailDocumentsWithFiling([email(1)]))[0].filing)
      .toMatchObject({ state: "removed", destination: null });
  });

  it("database lookup failures are explicit, not silently replaced with unverified destinations", async () => {
    dbMock.select.mockImplementationOnce(() => { throw new Error("Database unavailable"); });
    await expect(enrichEmailDocumentsWithFiling([email(1)])).rejects.toThrow("Database unavailable");
  });
});