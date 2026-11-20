import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
const mocks = vi.hoisted(() => ({ resolve:vi.fn(), devis:vi.fn(), stream:vi.fn(), members:vi.fn() }));
vi.mock("../storage", () => ({storage:{getDevis:mocks.devis,listProjectShareDevisIds:mocks.members}}));
vi.mock("../storage/object-storage", () => ({getDocumentStream:mocks.stream}));
vi.mock("../services/client-project-share", async original => ({
  ...await original<typeof import("../services/client-project-share")>(), resolveProjectShareToken:mocks.resolve,
}));
import router, { renderProjectShareShell } from "../routes/public-client-project-share";
let server:Server, base:string;
const token = "a".repeat(32);
const signed = {id:3,projectId:1,status:"draft",accountingState:"active",signOffStage:"client_signed_off",
  signedOffVia:null,signedPdfStorageKey:"signed-only",archisignEnvelopeId:"env",signedPdfArchisignEnvelopeId:"env"};
beforeAll(async () => {
  const app=express(); app.use(router);
  server=createServer(app); await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  base=`http://127.0.0.1:${(server.address() as {port:number}).port}/p/client/project/${token}/devis/3`;
});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
beforeEach(()=>{
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ok:true,token:{id:7,projectId:1}});
  mocks.devis.mockResolvedValue({...signed});
  mocks.members.mockResolvedValue([]);
  mocks.stream.mockImplementation(async()=>({stream:Readable.from(Buffer.from("%PDF-signed")),contentType:"application/pdf"}));
});
it("serves a signed PDF without explicit membership, never the original or mutable package", async()=>{
  const response=await fetch(`${base}/signed.pdf`);
  expect(response.status).toBe(200); expect(await response.text()).toBe("%PDF-signed");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.stream).toHaveBeenCalledWith("signed-only");
  for(const suffix of ["/data","/pdf","/package.pdf","/context-assets/7"]) expect((await fetch(base+suffix)).status).toBe(404);
});
it.each(["revoked","expired"])("rejects %s tokens before loading documents",async reason=>{
  mocks.resolve.mockResolvedValue({ok:false,reason});
  expect((await fetch(`${base}/signed.pdf`)).status).toBe(reason==="expired"?410:404);
  expect((await fetch(`${base}/context-assets/7`)).status).toBe(reason==="expired"?410:404);
  expect(mocks.stream).not.toHaveBeenCalled();
});
it.each([{projectId:2},{accountingState:"superseded"},{status:"void"},
  {signedPdfArchisignEnvelopeId:"wrong"},{signedPdfStorageKey:null}])("denies unsafe signed access: %s",async patch=>{
  mocks.devis.mockResolvedValue({...signed,...patch});
  expect((await fetch(`${base}/signed.pdf`)).status).toBe(404);
  expect(mocks.stream).not.toHaveBeenCalled();
});
it("does not expose storage errors or keys when signed bytes are unavailable",async()=>{
  mocks.stream.mockRejectedValue(new Error("private-storage-key"));
  const response=await fetch(`${base}/signed.pdf`);
  expect(response.status).toBe(404);expect(await response.text()).not.toContain("private-storage-key");
});
it("keeps budget values in a dedicated grid column and uses a signed preview route",()=>{
  const html=renderProjectShareShell({mode:"preview",projectId:1});
  expect(html).toContain("grid-template-columns: minmax(0, 1fr) 180px");
  expect(html).toContain(".card .top > :first-child .amount { white-space: normal;");
  expect(html).toContain(".card .top { grid-template-columns: minmax(0, 1fr); gap: 10px; }");
  expect(html).toContain('class="budget-money"');
  expect(html).toContain("/api/projects/1/client-share/preview/devis");
});
