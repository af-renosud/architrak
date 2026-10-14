import { z } from "zod";

const text = z.string().nullable();
const instant = z.string().datetime();
export const supplierDirectoryItemSchema = z.object({
  id: z.string().min(1), source: z.enum(["supplier-library", "ff-suppliers"]),
  sourceId: z.string().min(1), paymentSupplierId: z.string().min(1).nullable(),
  name: z.string().min(1), legalName: text, siret: text, specialty: text,
  website: text, email: text, phone: text,
  contacts: z.array(z.object({ id: z.string().min(1), name: text, email: text,
    phone: text, isPrimary: z.boolean() })),
  status: z.enum(["active", "inactive", "deleted"]), deletedAt: instant.nullable(),
  createdAt: instant, updatedAt: instant,
}).superRefine((item, ctx) => {
  const prefix = item.source === "supplier-library" ? "supplier-library:" : "ff-supplier:";
  if (item.id !== prefix + item.sourceId)
    ctx.addIssue({code:"custom",message:"Supplier identity namespace mismatch"});
  if (new Set(item.contacts.map(c => c.id)).size !== item.contacts.length)
    ctx.addIssue({code:"custom",message:"Duplicate contact identities"});
});
export const supplierDirectoryPageSchema = z.object({
  schemaVersion: z.literal(1), scope: z.literal("supplier-directory"),
  sources: z.tuple([z.literal("supplier-library"),z.literal("ff-suppliers")]),
  snapshotId: z.string().min(1), snapshotAt: instant, expiresAt: instant,
  totalCount: z.number().int().min(0).max(100000),
  items: z.array(supplierDirectoryItemSchema).max(500),
  nextCursor: z.string().min(1).nullable(), complete: z.boolean(),
});
export type SupplierDirectoryPage = z.infer<typeof supplierDirectoryPageSchema>;
export class SupplierDirectoryExpiredError extends Error {}

/**
 * Stages a complete immutable snapshot in memory. No database mutation is
 * permitted here. Callers receive nothing usable for reconciliation on failure.
 * Not connected to scheduled sync until the upstream rollout is confirmed.
 */
export async function stageSupplierDirectory(
  readPage: (params: Record<string,string>) => Promise<unknown>,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let first: SupplierDirectoryPage | undefined;
      let cursor: string | null = null;
      const cursors = new Set<string>(), ids = new Set<string>();
      const items: SupplierDirectoryPage["items"] = [];
      for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
        const page = supplierDirectoryPageSchema.parse(await readPage(
          cursor === null ? {limit:"200"} : {cursor},
        ));
        first ??= page;
        if (page.snapshotId !== first.snapshotId || page.totalCount !== first.totalCount ||
            page.snapshotAt !== first.snapshotAt || page.expiresAt !== first.expiresAt)
          throw new Error("Supplier snapshot changed between pages");
        if (Date.parse(page.expiresAt) <= Date.now()) throw new SupplierDirectoryExpiredError();
        for (const item of page.items) {
          if (ids.has(item.id)) throw new Error("Duplicate supplier identity");
          ids.add(item.id); items.push(item);
        }
        if (items.length > page.totalCount) throw new Error("Supplier snapshot count exceeded");
        if (page.complete !== (page.nextCursor === null))
          throw new Error("Inconsistent supplier completion marker");
        if (page.complete) {
          if (items.length !== page.totalCount) throw new Error("Incomplete supplier snapshot");
          return {...first, items, nextCursor:null, complete:true as const};
        }
        if (!page.items.length || cursors.has(page.nextCursor!))
          throw new Error("Non-progressing supplier cursor");
        cursor = page.nextCursor; cursors.add(cursor!);
      }
      throw new Error("Supplier snapshot page limit exceeded");
    } catch (error) {
      if (error instanceof SupplierDirectoryExpiredError && attempt === 0) continue;
      throw error;
    }
  }
  throw new Error("Supplier snapshot unavailable");
}
