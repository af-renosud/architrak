import "./_group.css";
import { CardShell, Identity, StatusPill, Totals, TechLabel, NAVY } from "./_shared";
import { FileText, Receipt, FilePlus2 } from "lucide-react";

function IconBtn({ icon: Icon, label }: { icon: React.ElementType; label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="h-8 w-8 inline-flex items-center justify-center rounded-md border border-neutral-200 text-neutral-700 hover:bg-neutral-50 bg-white"
    >
      <Icon size={13} />
    </button>
  );
}

export function CompactToolbar() {
  return (
    <CardShell expanded>
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <Identity />
        </div>

        <div className="flex items-center gap-3 px-3">
          <StatusPill label="PENDING" />
          <span className="h-4 w-px bg-neutral-200" />
          <div className="flex items-center gap-1">
            <TechLabel>Mode</TechLabel>
            <span className="text-[11px] font-semibold text-neutral-800">B</span>
          </div>
          <span className="h-4 w-px bg-neutral-200" />
          <div className="flex items-center gap-1">
            <IconBtn icon={FileText} label="View PDF" />
            <IconBtn icon={Receipt} label="Facture" />
            <IconBtn icon={FilePlus2} label="Avenant" />
          </div>
        </div>

        <div
          className="pl-4 border-l-2 min-w-[150px]"
          style={{ borderColor: `${NAVY}33` }}
        >
          <Totals />
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-dashed border-neutral-200 text-[11px] text-neutral-400 italic">
        Actions collapse to icon-only inside a compact toolbar group. Totals stay as the final, right-anchored slot — clean, predictable, and never crowded.
      </div>
    </CardShell>
  );
}
