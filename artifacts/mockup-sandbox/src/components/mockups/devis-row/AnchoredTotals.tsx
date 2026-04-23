import "./_group.css";
import { CardShell, Identity, StatusPill, Totals, ViewPdfBtn, FactureBtn, AvenantBtn, TechLabel, NAVY } from "./_shared";

export function AnchoredTotals() {
  return (
    <CardShell expanded>
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <Identity />
        </div>

        <StatusPill label="PENDING" />

        <div className="flex items-center gap-1.5">
          <ViewPdfBtn />
          <FactureBtn />
          <AvenantBtn />
        </div>

        <div className="hidden min-[900px]:flex flex-col items-center px-3 border-l border-neutral-200">
          <TechLabel>Mode</TechLabel>
          <div className="text-[11px] font-semibold text-neutral-800 mt-0.5">Mode B</div>
        </div>

        <div
          className="ml-auto pl-4 border-l-2 min-w-[150px]"
          style={{ borderColor: `${NAVY}33` }}
        >
          <Totals />
        </div>
      </div>
      <div className="mt-4 pt-4 border-t border-dashed border-neutral-200 text-[11px] text-neutral-400 italic">
        Totals are now hard-anchored to the right edge with a navy rule. Pills/actions float left of the anchor and never push the numbers around.
      </div>
    </CardShell>
  );
}
