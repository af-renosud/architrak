import { ChevronDown, FileText, Receipt, FilePlus2 } from "lucide-react";

export const NAVY = "#0B2545";

export const SAMPLE = {
  code: "DVP0000580",
  number: "DVP0000580",
  description: "Aménagement Piscine",
  contractor: "AT PISCINES",
  amountTtc: "49 183,27 €",
  amountHt: "40 986,06 €",
  mode: "Mode B",
  status: "PENDING",
};

export function StatusPill({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-md border px-2 py-0.5 font-black uppercase tracking-widest whitespace-nowrap text-[8px] bg-amber-50 text-amber-700 border-amber-200">
      {label}
    </span>
  );
}

export function TechLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`text-[9px] font-black uppercase tracking-[0.2em] text-neutral-500 ${className}`}>
      {children}
    </span>
  );
}

export function ViewPdfBtn() {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md border border-[#0B2545]/20 text-[#0B2545] hover:bg-[#0B2545]/5 bg-white"
    >
      <FileText size={12} />
      <span className="text-[9px] font-bold uppercase tracking-widest">View PDF</span>
    </button>
  );
}

export function FactureBtn() {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-neutral-200 text-neutral-800 hover:bg-neutral-50 bg-white"
    >
      <Receipt size={12} />
      <span className="text-[9px] font-bold uppercase tracking-widest">Facture</span>
    </button>
  );
}

export function AvenantBtn() {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-neutral-200 text-neutral-800 hover:bg-neutral-50 bg-white"
    >
      <FilePlus2 size={12} />
      <span className="text-[9px] font-bold uppercase tracking-widest">Avenant</span>
    </button>
  );
}

export function CardShell({ children, expanded = true }: { children: React.ReactNode; expanded?: boolean }) {
  const border = expanded
    ? "border-2 border-[#0B2545]/40 shadow-[0_2px_8px_rgba(11,37,69,0.08)]"
    : "border border-black/5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]";
  return (
    <div className="devis-row-shell min-h-screen bg-[#f5f6f7] p-6 flex items-start justify-center">
      <div className={`w-full max-w-[1100px] bg-white rounded-[2rem] p-6 ${border}`}>
        {children}
      </div>
    </div>
  );
}

export function ChevronIcon() {
  return <ChevronDown size={14} className="text-neutral-700 shrink-0" />;
}

export function Identity() {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <ChevronIcon />
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[16px] font-black tracking-tight" style={{ color: NAVY }}>
            {SAMPLE.code}
          </span>
          <span className="text-[11px] text-neutral-500">N° {SAMPLE.number}</span>
        </div>
        <p className="text-[12px] text-neutral-900 mt-0.5 truncate">{SAMPLE.description}</p>
        <span className="text-[10px] text-neutral-500">{SAMPLE.contractor}</span>
      </div>
    </div>
  );
}

export function Totals({ align = "right" }: { align?: "right" | "left" }) {
  return (
    <div className={`text-${align} tabular-nums`}>
      <div className="text-[14px] font-semibold text-neutral-900 leading-none">{SAMPLE.amountTtc}</div>
      <div className="text-[9px] text-neutral-500 mt-0.5">TTC</div>
      <div className="text-[10px] text-neutral-500 mt-0.5">{SAMPLE.amountHt} HT</div>
    </div>
  );
}
