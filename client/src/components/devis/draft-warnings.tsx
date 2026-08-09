import { AlertTriangle, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";

export type DraftValidationWarning = {
  field: string;
  expected: any;
  actual: any;
  message: string;
  severity: "error" | "warning";
  /** Optional structured 1-based line numbers the warning refers to
   *  (emitted by the server for `lineFragment` warnings). */
  lines?: number[];
};

/**
 * Warning fields that should be surfaced in the dedicated rose contractor
 * advisory banner inside the draft review dialog instead of the generic
 * validation warnings list.
 *
 * Keep this list in sync with the warning fields emitted by the document
 * parser (see server/gmail/document-parser.ts) and any contractor identity
 * advisories we want to elevate.
 */
export const CONTRACTOR_ADVISORY_FIELDS: ReadonlySet<string> = new Set([
  "contractor_identity_mismatch",
  "contractor_siret_collision",
  "unknown_contractor",
  "contractorSiret",
  "contractorName",
]);

export type PartitionedDraftWarnings = {
  lotRefWarnings: DraftValidationWarning[];
  contractorAdvisories: DraftValidationWarning[];
  lineFragmentWarnings: DraftValidationWarning[];
  generic: DraftValidationWarning[];
};

/**
 * Partition the validation warnings attached to a draft devis into the three
 * buckets rendered by the draft review dialog. The contractor advisory bucket
 * and the lotReferences bucket are mutually exclusive with the generic list:
 * a warning that lands in either of those MUST NOT also appear in the generic
 * list, otherwise the user sees the same advisory twice.
 */
export function partitionDraftWarnings(
  warnings: DraftValidationWarning[] | null | undefined,
): PartitionedDraftWarnings {
  const all = warnings ?? [];
  const lotRefWarnings = all.filter((w) => w.field === "lotReferences");
  const contractorAdvisories = all.filter((w) =>
    CONTRACTOR_ADVISORY_FIELDS.has(w.field),
  );
  const lineFragmentWarnings = all.filter((w) => w.field === "lineFragment");
  const generic = all.filter(
    (w) =>
      w.field !== "lotReferences" &&
      w.field !== "lineFragment" &&
      !CONTRACTOR_ADVISORY_FIELDS.has(w.field),
  );
  return { lotRefWarnings, contractorAdvisories, lineFragmentWarnings, generic };
}

/**
 * 1-based line numbers a `lineFragment` warning points at. Prefers the
 * structured `lines` array the server now emits; falls back to parsing the
 * enumeration out of the message ("Lines 2, 5 have no price…") for warnings
 * persisted before the structured field existed. Message parsing only reads
 * the number list BEFORE the "ha(s|ve) no price" clause so unrelated digits
 * in descriptions can never leak in.
 */
export function suspectFragmentLineNumbers(w: DraftValidationWarning): number[] {
  if (Array.isArray(w.lines) && w.lines.length > 0) {
    return w.lines.filter((n) => Number.isInteger(n) && n >= 1);
  }
  const m = /^Lines?\s+([\d,\s]+)\s+ha(?:s|ve)\b/.exec(w.message ?? "");
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1);
}

/**
 * Minimal DOM contract needed by `focusContractorSelect`. Defined as a
 * structural type so the helper can be exercised in pure-Node tests without
 * pulling in jsdom.
 */
export interface FocusableSection {
  scrollIntoView: (opts?: ScrollIntoViewOptions) => void;
  querySelector: (selector: string) => { focus: () => void } | null;
}

export const CONTRACTOR_SELECT_TESTID = "select-draft-contractor";
export const FOCUS_CONTRACTOR_SELECT_DELAY_MS = 250;

/**
 * Scroll the contractor section into view and move keyboard focus to the
 * contractor picker. Extracted so the focus contract can be unit-tested
 * independently of the dialog's React tree.
 */
export function focusContractorSelect(
  section: FocusableSection | null,
  schedule: (cb: () => void, delay: number) => void = (cb, delay) => {
    setTimeout(cb, delay);
  },
): void {
  if (!section) return;
  section.scrollIntoView({ behavior: "smooth", block: "center" });
  const trigger = section.querySelector(
    `[data-testid="${CONTRACTOR_SELECT_TESTID}"]`,
  );
  if (trigger) {
    schedule(() => trigger.focus(), FOCUS_CONTRACTOR_SELECT_DELAY_MS);
  }
}

interface ContractorAdvisoryBannerProps {
  warnings: DraftValidationWarning[];
  devisId: number;
  isArchived?: boolean;
  onChooseContractor: () => void;
}

/**
 * Rose advisory banner shown at the top of the draft review dialog when the
 * SIRET / contractor name on the document doesn't cleanly match a single known
 * contractor. Surfaces each advisory message and offers a quick action that
 * focuses the contractor picker further down the dialog.
 *
 * Renders nothing when there are no advisories to show.
 */
export function ContractorAdvisoryBanner({
  warnings,
  devisId,
  isArchived = false,
  onChooseContractor,
}: ContractorAdvisoryBannerProps) {
  if (warnings.length === 0) return null;
  return (
    <div
      className="rounded-lg border-2 border-rose-400 bg-rose-50 dark:bg-rose-950/40 p-3 space-y-2.5"
      data-testid={`banner-contractor-advisory-${devisId}`}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="text-rose-600 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wider text-rose-800 dark:text-rose-300">
            Verify contractor
          </p>
          <p className="text-[10px] mt-0.5 text-rose-800/90 dark:text-rose-300/90">
            The SIRET or company name on this document doesn't cleanly match a single
            known contractor. Please confirm the right contractor before saving.
          </p>
          <ul className="mt-1.5 space-y-1">
            {warnings.map((w, i) => (
              <li
                key={i}
                className="text-[10px] text-rose-900/90 dark:text-rose-200/90"
                data-testid={`contractor-advisory-${devisId}-${i}`}
              >
                {w.message}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {!isArchived && (
        <div className="pl-6">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 border-rose-300 bg-white text-rose-800 hover:bg-rose-100 hover:text-rose-900"
            onClick={onChooseContractor}
            data-testid={`button-choose-contractor-${devisId}`}
          >
            <UserCog size={12} />
            <span className="text-[10px] font-bold uppercase tracking-widest">
              Choose contractor
            </span>
          </Button>
        </div>
      )}
    </div>
  );
}

export interface FragmentLineItemLike {
  lineNumber: number;
  description: string;
}

interface LineFragmentWarningBannerProps {
  warnings: DraftValidationWarning[];
  devisId: number;
  /** Persisted line items of the draft, used to show the suspect line's text
   *  and the previous line it should probably be merged into. Optional —
   *  the banner still renders the line numbers while they load. */
  lineItems?: FragmentLineItemLike[];
}

/**
 * Amber banner shown in the draft review dialog when the extraction carries a
 * `lineFragment` advisory (code `line_fragment_suspected`): zero-priced,
 * reference-less lines that are likely a continuation paragraph of the
 * previous item's description, mis-split into a standalone line. Flags each
 * suspect line and suggests merging it into the previous line BEFORE the
 * architect confirms the draft.
 *
 * Renders nothing when there are no lineFragment warnings.
 */
export function LineFragmentWarningBanner({
  warnings,
  devisId,
  lineItems,
}: LineFragmentWarningBannerProps) {
  if (warnings.length === 0) return null;
  const suspectNumbers = Array.from(
    new Set(warnings.flatMap((w) => suspectFragmentLineNumbers(w))),
  ).sort((a, b) => a - b);
  const byNumber = new Map<number, FragmentLineItemLike>(
    (lineItems ?? []).map((li) => [li.lineNumber, li]),
  );
  return (
    <div
      className="rounded-lg border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/40 p-3 space-y-2"
      data-testid={`banner-line-fragment-${devisId}`}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="text-amber-600 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
            Suspected split line{suspectNumbers.length > 1 ? "s" : ""}
          </p>
          <p className="text-[10px] mt-0.5 text-amber-800/90 dark:text-amber-300/90">
            {suspectNumbers.length > 0
              ? `Line${suspectNumbers.length > 1 ? "s" : ""} ${suspectNumbers.join(", ")} ha${suspectNumbers.length > 1 ? "ve" : "s"} no price and no item reference — likely a continuation of the previous line's description that was extracted as a separate item.`
              : warnings[0].message}{" "}
            Consider merging {suspectNumbers.length > 1 ? "each one" : "it"} into the
            previous line and verifying the numbering against the PDF before confirming.
          </p>
          {suspectNumbers.length > 0 && (
            <ul className="mt-1.5 space-y-1">
              {suspectNumbers.map((n) => {
                const suspect = byNumber.get(n);
                const previous = byNumber.get(n - 1);
                return (
                  <li
                    key={n}
                    className="text-[10px] text-amber-900/90 dark:text-amber-200/90 rounded-md border border-amber-300 dark:border-amber-800 bg-amber-100/60 dark:bg-amber-900/30 px-2 py-1"
                    data-testid={`line-fragment-suspect-${devisId}-${n}`}
                  >
                    <span className="font-bold">Line {n}</span>
                    {suspect ? <>: “{suspect.description}”</> : null}
                    {previous ? (
                      <span className="block text-amber-800/80 dark:text-amber-300/80">
                        → suggest merging into line {n - 1}: “{previous.description}”
                      </span>
                    ) : (
                      <span className="block text-amber-800/80 dark:text-amber-300/80">
                        → suggest merging into line {n - 1}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

interface GenericValidationWarningsListProps {
  warnings: DraftValidationWarning[];
}

/**
 * Generic validation warnings list. Rendered after the contractor advisory
 * banner; receives only the warnings that belong neither to the contractor
 * advisory bucket nor to the lotReferences bucket.
 *
 * Renders nothing when the list is empty.
 */
export function GenericValidationWarningsList({
  warnings,
}: GenericValidationWarningsListProps) {
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-1.5" data-testid="section-validation-warnings">
      {warnings.map((w, i) => (
        <div
          key={i}
          className={`flex items-start gap-2 px-2.5 py-1.5 rounded-md border text-[10px] ${
            w.severity === "error"
              ? "bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-400"
              : "bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400"
          }`}
          data-testid={`warning-${w.field}-${i}`}
        >
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>{w.message}</span>
        </div>
      ))}
    </div>
  );
}
