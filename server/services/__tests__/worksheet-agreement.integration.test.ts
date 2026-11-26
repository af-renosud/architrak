import { afterAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { pool } from "../../db";
import { worksheetService } from "../quotation-worksheet";
import { createWorksheetAgreementService } from "../worksheet-agreement";

/**
 * Sealed client copies, client comments, the contractor revision request and
 * the comparison, against the dev database. Fixtures are deleted afterwards.
 */
const created: { projectId?: number; contractorId?: number } = {};
afterAll(async () => {
  if (created.projectId) {
    await pool.query("DELETE FROM project_communications WHERE project_id=$1", [created.projectId]);
    await pool.query("DELETE FROM projects WHERE id=$1", [created.projectId]);
  }
  if (created.contractorId) await pool.query("DELETE FROM contractors WHERE id=$1", [created.contractorId]);
});

it("shares a sealed copy, takes comments, sends a French revision request and compares the revision", async () => {
  const actor = (await pool.query("SELECT id FROM users ORDER BY id LIMIT 1")).rows[0].id as number;
  const p = (await pool.query(`INSERT INTO projects(name,code,client_name) VALUES('Worksheet agreement test',$1,'Client') RETURNING id`, [`WA-${Date.now()}`])).rows[0];
  created.projectId = p.id;
  const k = (await pool.query(`INSERT INTO contractors(name,email,contact_name) VALUES('WA contractor','wa-contractor@example.com','M. Martin') RETURNING id`)).rows[0];
  created.contractorId = k.id;
  const insertDevis = async (code: string, rows: Array<[string, string, string, string]>) => {
    const d = (await pool.query(`INSERT INTO devis(project_id,contractor_id,devis_code,description_fr,amount_ht,amount_ttc,accounting_state)
      VALUES($1,$2,$3,'Test','1000','1100','active') RETURNING id`, [p.id, k.id, code])).rows[0];
    for (let i = 0; i < rows.length; i++) {
      const [desc, qty, pu, total] = rows[i];
      await pool.query(`INSERT INTO devis_line_items(devis_id,line_number,description,unit,quantity,unit_price_ht,total_ht)
        VALUES($1,$2,$3,'m2',$4,$5,$6)`, [d.id, i + 1, desc, qty, pu, total]);
    }
    return d.id as number;
  };
  const devisId = await insertDevis("WA.1", [["Démolition cloison", "10", "50", "500"], ["Enduit plâtre", "20", "25", "500"]]);

  const sent: number[] = [];
  const svc = createWorksheetAgreementService({ pool, send: async id => {
    sent.push(id);
    await pool.query("UPDATE project_communications SET status='sent', sent_at=now() WHERE id=$1", [id]);
  } });
  const ws = await worksheetService().create(devisId, { title: "Meeting 1" }, actor);
  const enduit = ws.lines.find(l => l.description === "Enduit plâtre")!;
  const edited = await worksheetService().updateLine(ws.worksheet.id, enduit.id, { expectedRevision: ws.worksheet.revision, clientQuantity: "12" }, actor);
  const rev = edited.worksheet.revision;

  // No active client link yet → refused.
  await expect(svc.share(ws.worksheet.id, { expectedRevision: rev }, actor)).rejects.toThrow("no active client link");
  const token = (await pool.query(`INSERT INTO client_project_share_tokens(project_id,token_hash,client_email,client_name)
    VALUES($1,$2,'client@example.com','Mrs Client') RETURNING id`, [p.id, createHash("sha256").update(`t-${Date.now()}`).digest("hex")])).rows[0];
  await expect(svc.share(ws.worksheet.id, { expectedRevision: rev - 1 }, actor)).rejects.toThrow("changed after you opened it");
  // English is required: no finalised translation, then a partial one, are both refused.
  await expect(svc.share(ws.worksheet.id, { expectedRevision: rev }, actor)).rejects.toThrow("Finalise this quotation's English translation");
  await pool.query(`INSERT INTO devis_translations(devis_id,status,line_translations) VALUES($1,'finalised',$2)`,
    [devisId, JSON.stringify([{ lineNumber: 1, translation: "Partition demolition" }])]);
  await expect(svc.share(ws.worksheet.id, { expectedRevision: rev }, actor)).rejects.toThrow("1 line has no approved English wording");
  expect((await svc.shareState(ws.worksheet.id)).englishBlocker).toContain("1 line");
  await pool.query(`UPDATE devis_translations SET line_translations=$2 WHERE devis_id=$1`,
    [devisId, JSON.stringify([{ lineNumber: 1, translation: "Partition demolition" }, { lineNumber: 2, translation: "Plaster coat" }])]);
  expect((await svc.shareState(ws.worksheet.id)).englishBlocker).toBeNull();
  const shared = await svc.share(ws.worksheet.id, { expectedRevision: rev }, actor);
  expect(shared.unchanged).toBe(false);
  expect(await svc.share(ws.worksheet.id, { expectedRevision: rev }, actor)).toEqual({ releaseId: shared.releaseId, unchanged: true });
  await expect(pool.query("UPDATE client_worksheet_releases SET payload='{}' WHERE id=$1", [shared.releaseId])).rejects.toThrow("sealed");

  // Later edits do not reach the client until re-shared.
  await worksheetService().updateLine(ws.worksheet.id, enduit.id, { expectedRevision: rev, clientQuantity: "10" }, actor);
  const visible = await svc.publicRelease(p.id, shared.releaseId);
  expect(visible?.worksheet.revised.htCents).toBe(80000);
  expect(visible?.worksheet.lots[0].lines.map(l => l.description)).toEqual(["Partition demolition", "Plaster coat"]);
  expect((await svc.visibleForProject(p.id)).map(v => v.releaseId)).toEqual([shared.releaseId]);

  const tok = { id: token.id, projectId: p.id, clientEmail: "client@example.com", clientName: "Mrs Client" };
  await svc.addClientComment(tok, shared.releaseId, { body: "Can we keep the plaster on the north wall?" });
  await expect(svc.addClientComment({ ...tok, projectId: p.id + 100000 }, shared.releaseId, { body: "x" })).rejects.toThrow("no longer shared");
  let state = await svc.shareState(ws.worksheet.id);
  expect(state.unreadComments).toBe(1);
  await svc.acknowledgeComments(ws.worksheet.id, shared.releaseId, actor);
  state = await svc.shareState(ws.worksheet.id);
  expect(state.unreadComments).toBe(0);

  // Revision request: French, recorded, idempotent per request id.
  const current = await worksheetService().get(ws.worksheet.id);
  const preview = await svc.previewRevisionRequest(ws.worksheet.id, {});
  expect(preview.canSend).toBe(true);
  expect(preview.body).toContain("quantité : 20 m2 → 10 m2");
  const requestId = "6f1f8d64-4c7b-4b52-9b0e-2a9d1b7c3e11";
  const first = await svc.sendRevisionRequest(ws.worksheet.id, { expectedRevision: current.worksheet.revision, requestId }, actor);
  expect(first.status).toBe("sent");
  const replay = await svc.sendRevisionRequest(ws.worksheet.id, { expectedRevision: current.worksheet.revision, requestId }, actor);
  expect(replay).toMatchObject({ requestId: first.requestId, status: "sent" });
  expect(sent).toHaveLength(1);
  const comm = (await pool.query("SELECT type, recipient_email, related_devis_id FROM project_communications WHERE id=$1", [sent[0]])).rows[0];
  expect(comm).toEqual({ type: "devis_revision_request", recipient_email: "wa-contractor@example.com", related_devis_id: devisId });
  expect((await svc.listRevisionRequests(ws.worksheet.id))[0]).toMatchObject({ status: "sent", changeCount: 1 });

  // Revised quotation arrives with the wrong quantity.
  const revisedId = await insertDevis("WA.2", [["Démolition cloison", "10", "50", "500"], ["Enduit plâtre", "12", "25", "300"]]);
  const candidates = await svc.comparisonCandidates(ws.worksheet.id);
  expect(candidates.candidates.map(c => c.id)).toContain(revisedId);
  const cmp = await svc.compare(ws.worksheet.id, revisedId);
  expect(cmp.basis.kind).toBe("revision_request");
  expect(cmp.comparison.counts).toMatchObject({ as_agreed: 1, quantity_differs: 1 });

  // A later request that fails must not replace what the contractor actually received.
  const afterSend = await worksheetService().get(ws.worksheet.id);
  const plaster = afterSend.lines.find(l => l.description === "Enduit plâtre")!;
  const reEdited = await worksheetService().updateLine(ws.worksheet.id, plaster.id, { expectedRevision: afterSend.worksheet.revision, clientQuantity: "5" }, actor);
  const failing = createWorksheetAgreementService({ pool, send: async id => {
    await pool.query("UPDATE project_communications SET status='failed' WHERE id=$1", [id]);
    throw new Error("provider down");
  } });
  const failed = await failing.sendRevisionRequest(ws.worksheet.id,
    { expectedRevision: reEdited.worksheet.revision, requestId: "0b7c2a1e-3d4f-4a5b-8c6d-7e8f9a0b1c2d" }, actor);
  expect(failed.status).toBe("failed");
  const afterFailure = await svc.compare(ws.worksheet.id, revisedId);
  expect(afterFailure.basis).toMatchObject({ kind: "revision_request", requestId: first.requestId });
  expect(afterFailure.undeliveredRequest).toMatchObject({ id: failed.requestId, status: "failed" });
  expect(afterFailure.comparison.counts).toMatchObject({ as_agreed: 1, quantity_differs: 1 });

  // Share A → share B: only B is published. Stop sharing B: nothing resurfaces.
  const latest = await worksheetService().get(ws.worksheet.id);
  const sharedB = await svc.share(ws.worksheet.id, { expectedRevision: latest.worksheet.revision }, actor);
  expect(sharedB.releaseId).not.toBe(shared.releaseId);
  expect(await svc.publicRelease(p.id, shared.releaseId)).toBeNull();
  expect((await svc.visibleForProject(p.id)).map(v => v.releaseId)).toEqual([sharedB.releaseId]);
  await svc.withdraw(ws.worksheet.id, sharedB.releaseId, actor);
  expect(await svc.publicRelease(p.id, sharedB.releaseId)).toBeNull();
  expect(await svc.visibleForProject(p.id)).toEqual([]);
  const after = await svc.shareState(ws.worksheet.id);
  expect(after.releases.every(r => !r.current && r.withdrawnAt)).toBe(true);
  expect((await svc.devisSummary(devisId))[ws.worksheet.id].sharedRevision).toBeNull();
}, 60000);
