import { db } from "../server/db";
import { eq, and, isNotNull } from "drizzle-orm";
import { archidocContractors, contractors } from "@shared/schema";
import { normaliseSiretForStorage } from "../server/archidoc/contractor-auto-sync";

async function main() {
  const mirrors = await db
    .select({
      archidocId: archidocContractors.archidocId,
      name: archidocContractors.name,
      siret: archidocContractors.siret,
    })
    .from(archidocContractors)
    .where(isNotNull(archidocContractors.siret));

  let updated = 0;
  let unchanged = 0;
  let noLocal = 0;
  let invalidSiret = 0;
  let overwroteWrongFormat = 0;

  for (const mirror of mirrors) {
    const normalised = normaliseSiretForStorage(mirror.siret);
    if (!normalised) {
      invalidSiret++;
      continue;
    }

    const [local] = await db
      .select({ id: contractors.id, siret: contractors.siret, name: contractors.name })
      .from(contractors)
      .where(
        and(
          eq(contractors.archidocId, mirror.archidocId),
        ),
      )
      .limit(1);

    if (!local) {
      noLocal++;
      continue;
    }

    if (local.siret === normalised) {
      unchanged++;
      continue;
    }

    if (local.siret && local.siret !== normalised) {
      overwroteWrongFormat++;
    }

    await db
      .update(contractors)
      .set({ siret: normalised })
      .where(eq(contractors.id, local.id));
    updated++;
  }

  console.log(
    `[backfill-contractor-sirets] mirrors=${mirrors.length} updated=${updated} unchanged=${unchanged} noLocal=${noLocal} invalidSiret=${invalidSiret} overwroteWrongFormat=${overwroteWrongFormat}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-contractor-sirets] failed:", err);
    process.exit(1);
  });
