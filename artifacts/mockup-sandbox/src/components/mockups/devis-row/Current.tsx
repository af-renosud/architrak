import "./_group.css";
import { CardShell, Identity, StatusPill, Totals, ViewPdfBtn, FactureBtn, AvenantBtn, TechLabel } from "./_shared";

export function Current() {
  return (
    <CardShell expanded>
      <div className="grid items-center gap-4" style={{ gridTemplateColumns: "minmax(260px,1fr) auto auto auto auto" }}>
        <Identity />
        <StatusPill label="PENDING" />
        <div className="flex items-center gap-1.5">
          <ViewPdfBtn />
          <FactureBtn />
          <AvenantBtn />
        </div>
        <div className="text-center">
          <TechLabel>Mode</TechLabel>
          <div className="text-[11px] font-semibold text-neutral-800 mt-0.5">Mode B</div>
        </div>
        <Totals />
      </div>
      <div className="mt-4 pt-4 border-t border-dashed border-neutral-200 text-[11px] text-neutral-400 italic">
        Expanded content area (line items, history, attachments…)
      </div>
    </CardShell>
  );
}
