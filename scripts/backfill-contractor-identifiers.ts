import { db } from "../server/db";
import { eq, isNotNull } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { archidocContractors, contractors } from "@shared/schema";
import { normaliseSiretForStorage } from "../server/archidoc/contractor-auto-sync";

// Generalised "backfill contractor identifiers from the ArchiDoc mirror".
//
// When ArchiDoc starts surfacing additional contractor identifiers (TVA, APE,
// etc.) and ArchiTrak adds matching columns to `contractors` / the mirror, add
// a new entry to IDENTIFIER_SPECS below. The script is idempotent and safe to
// re-run on every deploy: rows whose stored value already matches the mirror
// (after normalisation) are left untouched.

type ContractorRow = typeof contractors.$inferSelect;
type ContractorInsert = typeof contractors.$inferInsert;

interface IdentifierSpec<K extends keyof ContractorRow & keyof ContractorInsert & string> {
  key: string;
  mirrorColumn: PgColumn;
  localField: K;
  normalise: (raw: unknown) => string | null;
}

function defineSpec<K extends keyof ContractorRow & keyof ContractorInsert & string>(
  spec: IdentifierSpec<K>,
): IdentifierSpec<K> {
  return spec;
}

const IDENTIFIER_SPECS = [
  defineSpec({
    key: "siret",
    mirrorColumn: archidocContractors.siret,
    localField: "siret",
    normalise: (raw) => normaliseSiretForStorage(raw as string | null | undefined),
  }),
] as const;

interface BackfillStats {
  key: string;
  mirrors: number;
  updated: number;
  unchanged: number;
  noLocal: number;
  invalid: number;
  overwroteWrongFormat: number;
}

async function backfillIdentifier<K extends keyof ContractorRow & keyof ContractorInsert & string>(
  spec: IdentifierSpec<K>,
): Promise<BackfillStats> {
  const mirrors = await db
    .select({
      archidocId: archidocContractors.archidocId,
      value: spec.mirrorColumn,
    })
    .from(archidocContractors)
    .where(isNotNull(spec.mirrorColumn));

  const stats: BackfillStats = {
    key: spec.key,
    mirrors: mirrors.length,
    updated: 0,
    unchanged: 0,
    noLocal: 0,
    invalid: 0,
    overwroteWrongFormat: 0,
  };

  for (const mirror of mirrors) {
    const normalised = spec.normalise(mirror.value);
    if (!normalised) {
      stats.invalid++;
      continue;
    }

    const [local] = await db
      .select()
      .from(contractors)
      .where(eq(contractors.archidocId, mirror.archidocId))
      .limit(1);

    if (!local) {
      stats.noLocal++;
      continue;
    }

    const currentValue = local[spec.localField];
    if (currentValue === normalised) {
      stats.unchanged++;
      continue;
    }

    if (currentValue && currentValue !== normalised) {
      stats.overwroteWrongFormat++;
    }

    const update: Partial<ContractorInsert> = { [spec.localField]: normalised };
    await db.update(contractors).set(update).where(eq(contractors.id, local.id));
    stats.updated++;
  }

  return stats;
}

async function main() {
  const startedAt = Date.now();
  console.log(
    `[backfill-contractor-identifiers] starting, identifiers=${IDENTIFIER_SPECS.map((s) => s.key).join(",")}`,
  );

  for (const spec of IDENTIFIER_SPECS) {
    const stats = await backfillIdentifier(spec);
    console.log(
      `[backfill-contractor-identifiers] ${stats.key}: mirrors=${stats.mirrors} updated=${stats.updated} unchanged=${stats.unchanged} noLocal=${stats.noLocal} invalid=${stats.invalid} overwroteWrongFormat=${stats.overwroteWrongFormat}`,
    );
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`[backfill-contractor-identifiers] done in ${elapsedMs}ms`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill-contractor-identifiers] failed:", err);
    process.exit(1);
  });
