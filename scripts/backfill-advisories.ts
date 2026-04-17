import { db } from "../server/db";
import { devis, invoices } from "@shared/schema";
import { reconcileAdvisories } from "../server/services/advisory-reconciler";
import type { ValidatorWarningLike } from "@shared/advisory-codes";

async function main() {
  const allDevis = await db.select().from(devis);
  let devisProcessed = 0;
  let devisWithWarnings = 0;
  for (const d of allDevis) {
    const w = (d.validationWarnings as ValidatorWarningLike[] | null) ?? [];
    if (w.length === 0) continue;
    devisWithWarnings++;
    await reconcileAdvisories({ devisId: d.id }, w, "ai_extraction");
    devisProcessed++;
  }

  const allInvoices = await db.select().from(invoices);
  let invoicesProcessed = 0;
  let invoicesWithWarnings = 0;
  for (const inv of allInvoices) {
    const w = (inv.validationWarnings as ValidatorWarningLike[] | null) ?? [];
    if (w.length === 0) continue;
    invoicesWithWarnings++;
    await reconcileAdvisories({ invoiceId: inv.id }, w, "ai_extraction");
    invoicesProcessed++;
  }

  console.log(
    `Backfill complete. Devis: ${devisProcessed}/${devisWithWarnings} (of ${allDevis.length} total). ` +
      `Invoices: ${invoicesProcessed}/${invoicesWithWarnings} (of ${allInvoices.length} total).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
