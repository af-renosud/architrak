import { it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { archidocContractors, archidocSyncLog } from "@shared/schema";
import * as client from "../sync-client";
import { syncContractors } from "../sync-service";

it("reports actual partial updates, retains suppliers, skips reconciliation and does not mark completion", async () => {
  const rollback = new Error("rollback partial-sync fixture"), original = db.transaction.bind(db);
  await expect(original(async tx => {
    const id = `partial-sync-${Date.now()}`;
    await tx.insert(archidocContractors).values({archidocId:`${id}-supplier`,name:"Retained supplier",
      partnerType:"supplier",sourceBaseUrl:"https://archiouvro.com",isDeleted:false});
    vi.spyOn(db,"select").mockImplementation((...args:any[]) => (tx.select as any)(...args));
    vi.spyOn(db,"insert").mockImplementation((...args:any[]) => (tx.insert as any)(...args));
    vi.spyOn(db,"update").mockImplementation((...args:any[]) => (tx.update as any)(...args));
    vi.spyOn(client,"isArchidocConfigured").mockReturnValue(true);
    vi.spyOn(client,"fetchContractors").mockResolvedValue({syncTimestamp:new Date().toISOString(),contractors:[
      {id:`${id}-contractor`,name:"Updated contractor"},
      {id:`${id}-supplier`,name:"Must not overwrite supplier"},
    ]});
    vi.spyOn(client,"fetchSuppliers").mockRejectedValue(new Error("supplier_directory_contract_unavailable"));
    try {
      const result = await syncContractors(false);
      expect(result).toMatchObject({updated:1,error:"supplier_directory_contract_unavailable"});
      expect(await tx.select().from(archidocContractors).where(eq(archidocContractors.archidocId,`${id}-supplier`)))
        .toMatchObject([{name:"Retained supplier",partnerType:"supplier",isDeleted:false}]);
      const logs = await tx.select().from(archidocSyncLog).where(eq(archidocSyncLog.errorMessage,"supplier_directory_contract_unavailable"));
      expect(logs.some(row => row.status === "failed" && row.recordsUpdated === 1)).toBe(true);
    } finally { vi.restoreAllMocks(); }
    throw rollback;
  })).rejects.toBe(rollback);
},30000);
