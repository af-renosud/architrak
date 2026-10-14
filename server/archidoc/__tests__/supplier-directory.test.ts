import { expect, it, vi } from "vitest";
import { stageSupplierDirectory, SupplierDirectoryExpiredError } from "../supplier-directory";
const item = (id:string) => ({id:`supplier-library:${id}`,source:"supplier-library",sourceId:id,
  paymentSupplierId:null,name:"Supplier",legalName:null,siret:null,specialty:null,website:null,
  email:null,phone:null,contacts:[],status:"active",deletedAt:null,
  createdAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z"});
const page = (items:any[]=[], nextCursor:string|null=null,totalCount=items.length) => ({
  schemaVersion:1,scope:"supplier-directory",sources:["supplier-library","ff-suppliers"],
  snapshotId:"snapshot",snapshotAt:"2026-01-01T00:00:00Z",expiresAt:"2099-01-01T00:00:00Z",
  items,nextCursor,totalCount,complete:nextCursor===null,
});
it("stages all pages and sends only opaque cursor on continuation",async()=>{
  const read=vi.fn().mockResolvedValueOnce(page([item("1")],"opaque?x",2))
    .mockResolvedValueOnce(page([item("2")],null,2));
  expect((await stageSupplierDirectory(read)).items).toHaveLength(2);
  expect(read.mock.calls).toEqual([[{limit:"200"}],[{cursor:"opaque?x"}]]);
});
it("accepts a completed empty snapshot",async()=>{
  expect((await stageSupplierDirectory(async()=>page())).items).toEqual([]);
});
it("rejects duplicate identities",async()=>{
  await expect(stageSupplierDirectory(async()=>page([item("1"),item("1")]))).rejects.toThrow("Duplicate");
});
it("rejects repeated cursors",async()=>{
  let n=0;
  await expect(stageSupplierDirectory(async()=>page([item(String(++n))],"same",10))).rejects.toThrow("cursor");
});
it("discards expired staging before one bounded restart",async()=>{
  const read=vi.fn().mockResolvedValueOnce(page([item("old")],"next",2))
    .mockRejectedValueOnce(new SupplierDirectoryExpiredError()).mockResolvedValueOnce(page([item("new")]));
  expect((await stageSupplierDirectory(read)).items[0].sourceId).toBe("new");
  expect(read.mock.calls[2]).toEqual([{limit:"200"}]);
});
it("does not return partial data or retry authentication/network errors",async()=>{
  const read=vi.fn().mockResolvedValueOnce(page([item("1")],"next",2))
    .mockRejectedValueOnce(new Error("unauthorized"));
  await expect(stageSupplierDirectory(read)).rejects.toThrow("unauthorized");
  expect(read).toHaveBeenCalledTimes(2);
});
it.each([
  {...page(),schemaVersion:2},
  {...page(),totalCount:1},
  {...page(),complete:false},
  {...page([item("1")]),items:[{...item("1"),id:"1"}]},
])("rejects malformed or inconsistent snapshots",async(value)=>{
  await expect(stageSupplierDirectory(async()=>value)).rejects.toThrow();
});
