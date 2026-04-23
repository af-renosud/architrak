import "./_group.css";
import { CardShell, Identity, StatusPill, ViewPdfBtn, FactureBtn, AvenantBtn, TechLabel, NAVY, SAMPLE } from "./_shared";

export function TwoTier() {
  return (
    <CardShell expanded>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <Identity />
        </div>
        <div className="text-right tabular-nums shrink-0">
          <div className="text-[18px] font-black tracking-tight leading-none" style={{ color: NAVY }}>
            {SAMPLE.amountTtc}
          </div>
          <div className="text-[9px] font-bold uppercase tracking-widest text-neutral-500 mt-1">TTC</div>
          <div className="text-[10px] text-neutral-500 mt-0.5">{SAMPLE.amountHt} HT</div>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-neutral-100 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <StatusPill label="PENDING" />
          <span className="text-neutral-300">·</span>
          <TechLabel>Mode</TechLabel>
          <span className="text-[11px] font-semibold text-neutral-800">Mode B</span>
        </div>
        <div className="flex items-center gap-1.5">
          <ViewPdfBtn />
          <FactureBtn />
          <AvenantBtn />
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-dashed border-neutral-200 text-[11px] text-neutral-400 italic">
        Totals get their own top-right slot (promoted in size). Status + actions live on a quieter second tier underneath.
      </div>
    </CardShell>
  );
}
