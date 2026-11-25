import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  users, projects, contractors, devis, devisLineItems, devisTranslations, devisLineContexts,
  devisLineContextAssets, devisSupportingPdfs, devisReplacements, quotationArchitectAudit, type InsertDevis,
} from "@shared/schema";
import type { CarryForwardSelection } from "@shared/quotation-carry-forward";
import { getCarryForwardPreview, recoverCarryForward } from "../services/quotation-carry-forward";
import { getReplacementOptions, replaceQuotation } from "../services/quotation-replacement.service";
import { getDocumentBuffer, uploadDocument, deleteDocument } from "../storage/object-storage";

vi.mock("../storage/object-storage", () => ({
  getDocumentBuffer: vi.fn(async () => Buffer.from("image-bytes")),
  uploadDocument: vi.fn(async () => `/test/copy-${randomUUID()}`),
  deleteDocument: vi.fn(async () => {}),
}));
let projectId: number, actorId: number, contractorId: number;
const prefix = `carry-test-${randomUUID()}`;
beforeAll(async () => {
  [actorId] = (await db.insert(users).values({ googleId: prefix, email: `${prefix}@example.test` }).returning()).map(x => x.id);
  [projectId] = (await db.insert(projects).values({ code: prefix, name: prefix, clientName: "Test" }).returning()).map(x => x.id);
  [contractorId] = (await db.insert(contractors).values({ name: prefix }).returning()).map(x => x.id);
});
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (projectId) {
    await db.delete(devisReplacements).where(eq(devisReplacements.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId));
  }
  if (contractorId) await db.delete(contractors).where(eq(contractors.id, contractorId));
  if (actorId) await db.delete(users).where(eq(users.id, actorId));
});
async function quote(fields: Partial<InsertDevis> = {}) {
  const [row] = await db.insert(devis).values({
    projectId, contractorId, devisCode: randomUUID(), descriptionFr: "Source work",
    descriptionUk: "Architect English description", amountHt: "100", amountTtc: "120", ...fields,
  }).returning();
  return row;
}
async function fixture() {
  const aiExtractedData = { lineItems: [{ description: "Paint ceiling", quantity: 2, unit: "m²", unitPrice: 50, total: 100 }] };
  const source = await quote({ aiExtractedData });
  const target = await quote({ aiExtractedData, descriptionFr: "Revised work", descriptionUk: null, amountHt: "80", amountTtc: "96" });
  const [oldLine] = await db.insert(devisLineItems).values({
    devisId: source.id, lineNumber: 1, description: "Paint ceiling", quantity: "2", unit: "m²", unitPriceHt: "50", totalHt: "100",
    checkNotes: "PRIVATE contractor question", checkStatus: "approved",
  }).returning();
  const [newLine] = await db.insert(devisLineItems).values({
    devisId: target.id, lineNumber: 5, description: "Paint ceiling", quantity: "2", unit: "m²", unitPriceHt: "50", totalHt: "100",
  }).returning();
  const [asset] = await db.insert(devisLineContextAssets).values({
    devisId: source.id, devisLineItemId: oldLine.id, storageKey: "/test/original-image", mimeType: "image/png", sizeBytes: 11,
  }).returning();
  const document = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Architect context", marks: [{ type: "bold" }] }] },
    { type: "image", attrs: { assetId: asset.id, alt: "Ceiling detail", size: "small" } },
  ] };
  await db.insert(devisLineContexts).values({ devisId: source.id, devisLineItemId: oldLine.id, document });
  await db.insert(devisTranslations).values({
    devisId: source.id, status: "finalised", approvedAt: new Date(), approvedBy: actorId,
    headerTranslated: { summary: "Previous overview", workingDiscountHt: "20.00", humanReviewed: true },
    lineTranslations: [{ lineNumber: 1, originalDescription: "Paint ceiling", translation: "Paint the ceiling.", explanation: "Client explanation", edited: true, included: false, vatRate: "20" }],
  });
  return { source, target, oldLine, newLine, asset, document };
}
async function selection(f: Awaited<ReturnType<typeof fixture>>): Promise<CarryForwardSelection> {
  const p = await getCarryForwardPreview(f.source.id, f.target.id);
  return { version: p.version, setup: ["descriptionUk"], header: true, supportingPdfIds: [],
    lines: [{ sourceLineId: f.oldLine.id, targetLineId: f.newLine.id, context: true, translation: true }] };
}
async function replace(f: Awaited<ReturnType<typeof fixture>>, carryForward?: CarryForwardSelection) {
  const p = await getReplacementOptions(f.source.id);
  return replaceQuotation(f.source.id, {
    replacementDevisId: f.target.id, sourceVersion: p.source.version,
    targetVersion: p.candidates.find(c => c.id === f.target.id)!.version,
    impactVersion: p.impactVersion, note: "Updated scope", differentContractorAcknowledged: false, carryForward,
  }, actorId);
}

describe("replacement carry-forward", () => {
  it("preserves first-import identity before later wording edits", async () => {
    const f = await fixture();
    const { storage } = await import("../storage");
    const original = { description: "Install oak shelf", quantity: 1, unit: "u", unitPrice: 50, total: 50 };
    const [source] = await db.select().from(devis).where(eq(devis.id, f.source.id));
    const [target] = await db.select().from(devis).where(eq(devis.id, f.target.id));
    for (const quote of [source, target]) await db.update(devis).set({
      pdfStorageKey: `/test/source-${quote.id}.pdf`,
      aiExtractedData: { ...(quote.aiExtractedData as any), lineItems: [
        ...((quote.aiExtractedData as any).lineItems ?? []), original,
      ] },
    }).where(eq(devis.id, quote.id));
    const old = await storage.createDevisLineItem({ devisId: source.id, lineNumber: 2,
      description: original.description, quantity: "1", unit: "u", unitPriceHt: "50", totalHt: "50" });
    const next = await storage.createDevisLineItem({ devisId: target.id, lineNumber: 6,
      description: original.description, quantity: "1", unit: "u", unitPriceHt: "50", totalHt: "50" });
    await storage.updateDevisLineItem(old.id, { description: "Oak shelf with architect's retained wording" });
    const preview = await getCarryForwardPreview(source.id, target.id);
    expect(preview.sourceLines.find(l => l.id === old.id)?.suggestedTargetId).toBe(next.id);
    await replace(f);
    expect((await storage.getDevisLineItems(target.id)).find(l => l.id === next.id)?.description)
      .toBe("Oak shelf with architect's retained wording");
  });
  it("copies rich context, independent image bytes and translation by stable mapping, without source figures or approvals", async () => {
    const f = await fixture();
    const preview = await getCarryForwardPreview(f.source.id, f.target.id);
    expect(preview.sourceLines[0].suggestedTargetId).toBe(f.newLine.id);
    await replace(f, await selection(f));
    const [ctx] = await db.select().from(devisLineContexts).where(eq(devisLineContexts.devisLineItemId, f.newLine.id));
    const doc = ctx.document as typeof f.document;
    const image = doc.content[1] as any;
    expect(image.attrs).toMatchObject({ size: "small", alt: "Ceiling detail" });
    expect(image.attrs.assetId).not.toBe(f.asset.id);
    const [asset] = await db.select().from(devisLineContextAssets).where(eq(devisLineContextAssets.id, image.attrs.assetId));
    expect(asset).toMatchObject({ devisId: f.target.id, devisLineItemId: f.newLine.id });
    expect(asset.storageKey).not.toBe(f.asset.storageKey);
    expect(getDocumentBuffer).toHaveBeenCalledWith(f.asset.storageKey);
    expect(uploadDocument).toHaveBeenCalledTimes(1);
    const [tr] = await db.select().from(devisTranslations).where(eq(devisTranslations.devisId, f.target.id));
    expect(tr).toMatchObject({ status: "draft", approvedAt: null, approvedBy: null, translatedPdfStorageKey: null, contextsVersion: 1 });
    expect(tr.lineTranslations).toEqual([{ lineNumber: 5, originalDescription: "Paint ceiling", translation: "Paint the ceiling.", explanation: "Client explanation", edited: true }]);
    expect(tr.headerTranslated).toEqual({ summary: "Previous overview" });
    const [target] = await db.select().from(devis).where(eq(devis.id, f.target.id));
    expect(target).toMatchObject({ descriptionUk: f.source.descriptionUk, amountHt: "80.00", amountTtc: "96.00", signedPdfStorageKey: null, signOffStage: "received" });
    const [line] = await db.select().from(devisLineItems).where(eq(devisLineItems.id, f.newLine.id));
    expect(line.checkNotes).toBeNull();
    expect(line.checkStatus).toBe("unchecked");
    expect((await db.select().from(devisLineContexts).where(eq(devisLineContexts.devisLineItemId, f.oldLine.id)))[0].document).toEqual(f.document);
  });
  it("leaves unassigned work on the original and supports explicit later recovery", async () => {
    const f = await fixture();
    await db.update(devisLineItems).set({ description: "Changed ceiling specification" }).where(eq(devisLineItems.id, f.newLine.id));
    await replace(f);
    expect(await db.select().from(devisLineContexts).where(eq(devisLineContexts.devisLineItemId, f.newLine.id))).toHaveLength(0);
    const selected = await selection(f);
    await recoverCarryForward(f.source.id, f.target.id, selected, actorId);
    expect(await db.select().from(devisLineContexts).where(eq(devisLineContexts.devisLineItemId, f.newLine.id))).toHaveLength(1);
    await expect(recoverCarryForward(f.source.id, f.target.id, await selection(f), actorId)).rejects.toMatchObject({ code: "EXISTING_CONTENT" });
  });
  it("automatically retains exact unchanged context and translation without a selection", async () => {
    const f = await fixture();
    await replace(f);
    expect(await db.select().from(devisLineContexts).where(eq(devisLineContexts.devisLineItemId, f.newLine.id))).toHaveLength(1);
    const [tr] = await db.select().from(devisTranslations).where(eq(devisTranslations.devisId, f.target.id));
    expect((tr.lineTranslations as any[])[0].translation).toBe("Paint the ceiling.");
    expect(tr.approvedAt).toBeNull();
    expect((await db.select().from(devis).where(eq(devis.id, f.target.id)))[0].amountHt).toBe("80.00");
  });
  it("retains an authored French amendment through its audited source identity", async () => {
    const f = await fixture();
    await db.insert(quotationArchitectAudit).values({
      devisId: f.source.id, actorId, operation: "correction",
      beforeSnapshot: { lines: [{ id: f.oldLine.id, description: "Paint ceiling", quantity: "2",
        unit: "m²", unit_price_ht: "50", total_ht: "100" }] },
      afterSnapshot: { note: "Working wording amended" },
    });
    await db.update(devisLineItems).set({ description: "Paint ceiling — architect wording" }).where(eq(devisLineItems.id, f.oldLine.id));
    await db.update(devisTranslations).set({
      lineTranslations: [{ lineNumber: 1, originalDescription: "Paint ceiling — architect wording", translation: "Retained English wording", explanationFr: "Précision conservée" }],
    }).where(eq(devisTranslations.devisId, f.source.id));
    const preview = await getCarryForwardPreview(f.source.id, f.target.id);
    expect(preview.sourceLines[0].suggestedTargetId).toBe(f.newLine.id);
    await replace(f);
    const [line] = await db.select().from(devisLineItems).where(eq(devisLineItems.id, f.newLine.id));
    expect(line.description).toBe("Paint ceiling — architect wording");
    expect(line.totalHt).toBe("100.00");
    const [tr] = await db.select().from(devisTranslations).where(eq(devisTranslations.devisId, f.target.id));
    expect((tr.lineTranslations as any[])[0]).toMatchObject({
      originalDescription: line.description, translation: "Retained English wording", explanationFr: "Précision conservée",
    });
  });
  it("matches same wording with changed prices as 'figures changed', but never repeated rows", async () => {
    const f = await fixture();
    await db.update(devisLineItems).set({ unitPriceHt: "40" }).where(eq(devisLineItems.id, f.newLine.id));
    expect((await getCarryForwardPreview(f.source.id, f.target.id)).sourceLines[0]).toMatchObject({
      suggestedTargetId: f.newLine.id, matchKind: "wording", figuresChanged: true,
    });
    await db.update(devisLineItems).set({ unitPriceHt: "50" }).where(eq(devisLineItems.id, f.newLine.id));
    await db.insert(devisLineItems).values({ devisId: f.target.id, lineNumber: 6, description: "Paint ceiling", quantity: "2", unit: "m²", unitPriceHt: "50", totalHt: "100" });
    expect((await getCarryForwardPreview(f.source.id, f.target.id)).sourceLines[0].suggestedTargetId).toBeNull();
  });
  it("rejects stale context, duplicate mapping and existing target work atomically", async () => {
    const f = await fixture();
    const oldSelection = await selection(f);
    await db.update(devisLineContexts).set({ revision: 2 }).where(eq(devisLineContexts.devisLineItemId, f.oldLine.id));
    await expect(replace(f, oldSelection)).rejects.toMatchObject({ code: "STALE_CARRY_FORWARD" });
    const current = await selection(f);
    await expect(replace(f, { ...current, lines: [...current.lines, ...current.lines] })).rejects.toMatchObject({ code: "DUPLICATE_MAPPING" });
    await db.insert(devisLineContexts).values({ devisId: f.target.id, devisLineItemId: f.newLine.id, document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep me" }] }] } });
    await expect(replace(f, await selection(f))).rejects.toMatchObject({ code: "EXISTING_CONTENT" });
    expect((await db.select().from(devis).where(eq(devis.id, f.source.id)))[0].accountingState).not.toBe("superseded");
    expect(uploadDocument).not.toHaveBeenCalled();
  });
  it("rolls back replacement and cleans copied image if a later PDF copy fails", async () => {
    const f = await fixture();
    const [pdf] = await db.insert(devisSupportingPdfs).values({
      devisId: f.source.id, fileName: "plan.pdf", label: "Plan", storageKey: "/test/plan", pageCount: 1, byteSize: 5, position: 1,
    }).returning();
    vi.mocked(getDocumentBuffer).mockResolvedValueOnce(Buffer.from("image-bytes")).mockRejectedValueOnce(new Error("Object unavailable"));
    const selected = await selection(f);
    await expect(replace(f, { ...selected, supportingPdfIds: [pdf.id] })).rejects.toThrow("Object unavailable");
    expect(deleteDocument).toHaveBeenCalledTimes(1);
    expect(await db.select().from(devisLineContextAssets).where(eq(devisLineContextAssets.devisId, f.target.id))).toHaveLength(0);
    expect((await db.select().from(devis).where(eq(devis.id, f.source.id)))[0].accountingState).not.toBe("superseded");
  });
  it("protects signed and finalised targets, and requires a recorded relationship for recovery", async () => {
    const f = await fixture();
    await expect(recoverCarryForward(f.source.id, f.target.id, await selection(f), actorId)).rejects.toMatchObject({ code: "NOT_REPLACEMENT" });
    await db.insert(devisTranslations).values({ devisId: f.target.id, status: "finalised" });
    expect((await getCarryForwardPreview(f.source.id, f.target.id)).blockedReason).toContain("Reopen");
    await expect(replace(f, await selection(f))).rejects.toMatchObject({ code: "CARRY_FORWARD_BLOCKED" });
    await db.update(devis).set({ signedPdfStorageKey: "/test/signed.pdf" }).where(eq(devis.id, f.target.id));
    expect((await getCarryForwardPreview(f.source.id, f.target.id)).blockedReason).toContain("signed");
  });
  it("retains the structured name with a distinct sequence and independently copies selected plans", async () => {
    const f = await fixture();
    await db.update(devis).set({ devisCode: "PT.1.Ceiling finishes", lotRefText: "PT", lotSequence: 1 }).where(eq(devis.id, f.source.id));
    const [pdf] = await db.insert(devisSupportingPdfs).values({
      devisId: f.source.id, fileName: "selected-plan.pdf", label: "Architect's plan",
      storageKey: "/test/selected-plan", pageCount: 2, byteSize: 11, position: 1,
    }).returning();
    const p = await getCarryForwardPreview(f.source.id, f.target.id);
    expect(p.setup.find(field => field.key === "devisCode")?.from).toBe("PT.2.Ceiling finishes");
    await replace(f, { ...await selection(f), setup: ["devisCode", "descriptionUk"], supportingPdfIds: [pdf.id] });
    const [target] = await db.select().from(devis).where(eq(devis.id, f.target.id));
    expect(target).toMatchObject({ devisCode: "PT.2.Ceiling finishes", lotRefText: "PT", lotSequence: 2 });
    const [copy] = await db.select().from(devisSupportingPdfs).where(eq(devisSupportingPdfs.devisId, f.target.id));
    expect(copy).toMatchObject({ label: pdf.label, fileName: pdf.fileName, pageCount: 2 });
    expect(copy.storageKey).not.toBe(pdf.storageKey);
    expect((await db.select().from(devisReplacements).where(eq(devisReplacements.oldDevisId, f.source.id)))[0].newLabel).toContain(target.devisCode);
  });
  it("does not overwrite an existing overview or a translation even when its source wording is stale", async () => {
    const f = await fixture();
    await db.insert(devisTranslations).values({ devisId: f.target.id, status: "edited",
      headerTranslated: { summary: "Keep replacement overview" },
      lineTranslations: [{ lineNumber: 5, originalDescription: "Different earlier wording", translation: "Keep replacement translation" }],
    });
    const p = await getCarryForwardPreview(f.source.id, f.target.id);
    expect(p.header.available).toBe(false);
    expect(p.targetLines[0].translation).toBe("Keep replacement translation");
    await expect(replace(f, { ...await selection(f), header: false })).rejects.toMatchObject({ code: "EXISTING_CONTENT" });
    await expect(replace(f, { ...await selection(f), lines: [] })).rejects.toMatchObject({ code: "EXISTING_HEADER" });
  });
});
