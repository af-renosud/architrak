import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";
import { archidocContractors as mirror, archidocSupplierDirectory as directory,
  archidocSupplierPaymentReadiness as readiness, contractors, archidocSyncLog } from "@shared/schema";
import { prepareSupplierDirectorySnapshot, ArchidocFetchError } from "./sync-client";
import { supplierDirectoryItemSchema } from "./supplier-directory";
import type { SupplierDirectoryPage } from "./supplier-directory";

export type DirectorySyncResult = {updated:number; library:number; ff:number; absent:number; error?:string};

// Called under the shared mirror lock. This second lock also serializes direct
// callers/tests; all identity mappings and local changes commit in one transaction.
export async function commitSupplierDirectory(snapshot: SupplierDirectoryPage, source: string) {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('archidoc-supplier-directory'))`);
    if (!snapshot.complete || snapshot.nextCursor !== null ||
        new Set(snapshot.items.map(x => x.id)).size !== snapshot.totalCount ||
        snapshot.items.length !== snapshot.totalCount)
      throw new Error("Incomplete supplier directory cannot be committed");
    const now = new Date();
    const previous = await tx.select().from(directory).for("update");
    const touched = new Set<number>();
    for (const raw of snapshot.items) {
      const item = supplierDirectoryItemSchema.parse(raw);
      const mapping = previous.find(x => x.id === item.id);
      if (mapping && mapping.sourceBaseUrl !== source)
        throw new Error("Supplier identity belongs to another integration source");
      const candidates = [item.id, ...(item.paymentSupplierId ? [item.paymentSupplierId] : []),
        ...(item.source === "supplier-library" ? [item.sourceId] : [])];
      const matches = await tx.select().from(contractors).where(inArray(contractors.archidocId,candidates)).for("update");
      const existing = matches.filter(x => x.archidocId !== item.sourceId ||
        x.archidocPartnerType === "supplier" || x.archidocId === item.paymentSupplierId);
      if (existing.some(x => x.archidocPartnerType !== "supplier"))
        throw new Error("Supplier identity collides with a contractor; manual identity review required");
      const matched = new Set(existing.map(x=>x.id));
      if (mapping) matched.add(mapping.contractorId);
      if (matched.size > 1) throw new Error("Ambiguous supplier identity; refusing to merge records");
      let local = mapping
        ? (await tx.select().from(contractors).where(eq(contractors.id,mapping.contractorId)).for("update"))[0]
        : existing[0];
      const legacyMirror = item.source === "supplier-library"
        ? (await tx.select().from(mirror).where(and(eq(mirror.archidocId,item.sourceId),
          eq(mirror.partnerType,"supplier"),eq(mirror.sourceBaseUrl,source))))[0] : undefined;
      const canonical = item.paymentSupplierId ?? local?.archidocId ?? legacyMirror?.archidocId ?? item.id;
      if (!canonical || canonical.length > 255) throw new Error("Invalid canonical supplier identity");
      const owned = (await tx.select().from(readiness).where(eq(readiness.supplierArchidocId,canonical)))[0];
      const oldMirror = (await tx.select().from(mirror).where(eq(mirror.archidocId,canonical)))[0];
      if (oldMirror && (oldMirror.partnerType !== "supplier" ||
          (oldMirror.sourceBaseUrl && oldMirror.sourceBaseUrl !== source)))
        throw new Error("Supplier mirror identity collision");
      if (local && local.archidocId !== canonical) {
        // Explicit payment identity, never inferred from name/email. Keep the
        // existing local primary key and every invoice/history FK intact.
        const previousId = local.archidocId;
        await tx.update(contractors).set({archidocId:canonical}).where(eq(contractors.id,local.id));
        if (previousId) {
          if (!oldMirror) await tx.update(mirror).set({archidocId:canonical})
            .where(and(eq(mirror.archidocId,previousId),eq(mirror.partnerType,"supplier")));
          else await tx.update(mirror).set({isDeleted:true,deletedAt:now})
            .where(and(eq(mirror.archidocId,previousId),eq(mirror.partnerType,"supplier")));
        }
      }
      const contact = item.contacts.find(c=>c.isPrimary) ?? item.contacts[0];
      const oldContacts = Array.isArray(oldMirror?.contacts) ? oldMirror.contacts as Record<string,unknown>[] : [];
      const contacts = item.contacts.map(c=>({
        ...oldContacts.find(old=>old.id===c.id), ...c, mobile:c.phone,
      }));
      const siretDigits = item.siret?.replace(/\D/g,"");
      const siret = siretDigits?.length === 14 ? siretDigits : undefined;
      const fields = {name:item.name, siret, website:item.website, email:item.email ?? contact?.email ?? null,
        phone:item.phone ?? contact?.phone ?? null, contactName:contact?.name ?? null,
        contactMobile:contact?.phone ?? null};
      // Payment readiness owns legal/banking evidence. Directory membership
      // never creates eligibility or clears fields outside its allowlist.
      if (!local) {
        [local] = await tx.insert(contractors).values({...fields, archidocId:canonical,
          archidocPartnerType:"supplier"}).returning();
      } else if (!owned) {
        await tx.update(contractors).set(fields).where(eq(contractors.id,local.id));
      } else {
        await tx.update(contractors).set({email:fields.email,phone:fields.phone,
          contactName:fields.contactName,contactMobile:fields.contactMobile}).where(eq(contractors.id,local.id));
        await tx.update(mirror).set({contacts,
          officePhone:item.phone}).where(eq(mirror.archidocId,canonical));
      }
      if (!owned) {
        const values = {name:item.name, siret, website:item.website, officePhone:item.phone,
          contacts, partnerType:"supplier",
          sourceBaseUrl:source, syncedAt:now, archidocUpdatedAt:new Date(item.updatedAt)};
        await tx.insert(mirror).values({...values,archidocId:canonical})
          .onConflictDoUpdate({target:mirror.archidocId,set:values});
      }
      // External directory mapping migrates in place onto the SAME local row.
      // Keep canonical/payment IDs intact so historical links never break.
      await tx.insert(directory).values({id:item.id,sourceBaseUrl:source,contractorId:local.id,
        snapshotId:snapshot.snapshotId,data:item,isAbsent:false,syncedAt:now})
        .onConflictDoUpdate({target:directory.id,set:{snapshotId:snapshot.snapshotId,data:item,
          isAbsent:false,syncedAt:now}});
      touched.add(local.id);
    }
    const seen = new Set(snapshot.items.map(x=>x.id));
    let absent = 0;
    for (const old of previous.filter(x=>x.sourceBaseUrl===source && !seen.has(x.id))) {
      await tx.update(directory).set({isAbsent:true,snapshotId:snapshot.snapshotId,syncedAt:now})
        .where(eq(directory.id,old.id));
      touched.add(old.contractorId); absent++;
    }
    const all = await tx.select().from(directory).where(eq(directory.sourceBaseUrl,source));
    for (const id of Array.from(touched)) {
      const [local] = await tx.select().from(contractors).where(eq(contractors.id,id));
      if (!local?.archidocId || local.archidocPartnerType !== "supplier") throw new Error("Supplier mapping drift");
      if ((await tx.select().from(readiness).where(eq(readiness.supplierArchidocId,local.archidocId))).length)
        continue; // Payment source retains independent authority and tombstones.
      const active = all.some(x=>x.contractorId===id && !x.isAbsent &&
        supplierDirectoryItemSchema.parse(x.data).status==="active");
      await tx.update(mirror).set({isDeleted:!active,deletedAt:active?null:now})
        .where(and(eq(mirror.archidocId,local.archidocId),eq(mirror.sourceBaseUrl,source)));
      await tx.update(contractors).set({archidocOrphanedAt:active?null:now}).where(eq(contractors.id,id));
    }
    const result = {updated:snapshot.items.length,
      library:snapshot.items.filter(x=>x.source==="supplier-library").length,
      ff:snapshot.items.filter(x=>x.source==="ff-suppliers").length,absent};
    await tx.insert(archidocSyncLog).values({syncType:"supplier_directory",status:"completed",
      completedAt:now,recordsUpdated:result.updated});
    return result;
  });
}

export async function syncSupplierDirectory(): Promise<DirectorySyncResult> {
  try {
    if (!env.ARCHIDOC_BASE_URL) throw new Error("Supplier directory source is not configured");
    const snapshot = await prepareSupplierDirectorySnapshot();
    return await commitSupplierDirectory(snapshot,new URL(env.ARCHIDOC_BASE_URL).origin);
  } catch (failure) {
    // Do not persist upstream bodies, supplier names, raw SQL, or credentials.
    const category = failure instanceof ArchidocFetchError
      ? `${failure.diagnostic.code} (HTTP ${failure.diagnostic.status ?? "unavailable"})`
      : "validation_or_identity_or_database";
    const error = `Supplier directory import failed: ${category}; previous completed import retained. No absence reconciliation was committed.`;
    await db.insert(archidocSyncLog).values({syncType:"supplier_directory",status:"failed",
      completedAt:new Date(),recordsUpdated:0,errorMessage:error});
    return {updated:0,library:0,ff:0,absent:0,error};
  }
}
