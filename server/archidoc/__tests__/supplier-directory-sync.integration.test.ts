import { it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { contractors, archidocSupplierDirectory as directory } from "@shared/schema";
import { commitSupplierDirectory } from "../supplier-directory-sync";
import type { SupplierDirectoryPage } from "../supplier-directory";

it("atomically maps legacy identities, keeps sources separate and preserves history on absence",async()=>{
  const original=db.transaction.bind(db), rollback=new Error("rollback fixture");
  await expect(original(async tx=>{
    const id=`directory-test-${Date.now()}`,source=`https://${id}.invalid`;
    const [legacy]=await tx.insert(contractors).values({name:"Legacy",archidocId:id,
      archidocPartnerType:"supplier",bankName:"Retain banking",notes:"Retain notes"}).returning();
    vi.spyOn(db,"transaction").mockImplementation(cb=>tx.transaction(cb) as any);
    const item:any={id:`supplier-library:${id}`,source:"supplier-library",sourceId:id,paymentSupplierId:null,
      name:"Current name",legalName:null,siret:null,specialty:null,website:null,email:null,phone:null,
      contacts:[],status:"active",deletedAt:null,createdAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z"};
    const snapshot=(items:any[]):SupplierDirectoryPage=>({schemaVersion:1,scope:"supplier-directory",
      sources:["supplier-library","ff-suppliers"],snapshotId:"test",snapshotAt:"2026-01-01T00:00:00Z",
      expiresAt:"2099-01-01T00:00:00Z",items,totalCount:items.length,complete:true,nextCursor:null});
    try {
      expect(await commitSupplierDirectory(snapshot([item,{...item,id:`ff-supplier:${id}`,source:"ff-suppliers"}]),source))
        .toMatchObject({library:1,ff:1,updated:2});
      const mappings=await tx.select().from(directory).where(eq(directory.sourceBaseUrl,source));
      expect(mappings).toHaveLength(2);
      expect(new Set(mappings.map(m=>m.contractorId)).size).toBe(2);
      expect(mappings.find(m=>m.id===item.id)?.contractorId).toBe(legacy.id);
      await commitSupplierDirectory(snapshot([{...item,contacts:[{id:"contact",name:"New contact",
        email:null,phone:"0000",isPrimary:true}]}]),source);
      expect((await tx.select().from(contractors).where(eq(contractors.id,legacy.id)))[0])
        .toMatchObject({contactName:"New contact",bankName:"Retain banking",notes:"Retain notes"});
      await expect(commitSupplierDirectory(snapshot([{...item,name:"Must roll back"},
        {...item,id:"bad-namespace"}]),source)).rejects.toThrow();
      expect((await tx.select().from(contractors).where(eq(contractors.id,legacy.id)))[0].name).toBe("Current name");
      await commitSupplierDirectory(snapshot([{...item,paymentSupplierId:`payment-${id}`}]),source);
      expect((await tx.select().from(contractors).where(eq(contractors.id,legacy.id)))[0])
        .toMatchObject({id:legacy.id,archidocId:`payment-${id}`,bankName:"Retain banking"});
      await commitSupplierDirectory(snapshot([]),source);
      const [retained]=await tx.select().from(contractors).where(eq(contractors.id,legacy.id));
      expect(retained.archidocOrphanedAt).not.toBeNull();
      expect(retained.bankName).toBe("Retain banking");
      expect((await tx.select().from(directory).where(eq(directory.id,item.id)))[0].isAbsent).toBe(true);
    } finally {vi.restoreAllMocks();}
    throw rollback;
  })).rejects.toBe(rollback);
},30000);
