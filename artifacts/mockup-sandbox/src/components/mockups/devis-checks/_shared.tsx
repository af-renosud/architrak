import { ChevronDown, FileText } from "lucide-react";

export const NAVY = "#0B2545";

export type LineStatus = "green" | "amber" | "red" | null;

export type Line = {
  n: number;
  desc: string;
  qty: string;
  unit: string;
  unitHt: string;
  totalHt: string;
  pct: string;
  status: LineStatus;
};

export const SAMPLE = {
  code: "DVP0000580",
  number: "DVP0000580",
  description: "Aménagement Piscine — Chantier Renosud / Villa Sophia",
  contractor: "AT PISCINES",
  amountTtc: "49 183,27 €",
  amountHt: "40 986,06 €",
};

export const INITIAL_LINES: Line[] = [
  { n: 1, desc: "Préparation du terrain et terrassement", qty: "1", unit: "ft", unitHt: "3 200,00", totalHt: "3 200,00", pct: "100", status: "green" },
  { n: 2, desc: "Bassin béton 8m × 4m × 1.5m, structure renforcée", qty: "1", unit: "u", unitHt: "18 500,00", totalHt: "18 500,00", pct: "60", status: "red" },
  { n: 3, desc: "Local technique + raccordements hydrauliques", qty: "1", unit: "u", unitHt: "4 800,00", totalHt: "4 800,00", pct: "30", status: "green" },
  { n: 4, desc: "Margelles pierre reconstituée — pose comprise", qty: "32", unit: "ml", unitHt: "85,00", totalHt: "2 720,00", pct: "0", status: "red" },
  { n: 5, desc: "Liner armé 150/100 — coloris sable", qty: "60", unit: "m²", unitHt: "78,00", totalHt: "4 680,00", pct: "0", status: "green" },
  { n: 6, desc: "Système de filtration + traitement automatique", qty: "1", unit: "u", unitHt: "3 200,00", totalHt: "3 200,00", pct: "0", status: "red" },
  { n: 7, desc: "Éclairage LED submersible (4 spots)", qty: "4", unit: "u", unitHt: "210,00", totalHt: "840,00", pct: "0", status: null },
  { n: 8, desc: "Volet roulant immergé motorisé", qty: "1", unit: "u", unitHt: "3 046,06", totalHt: "3 046,06", pct: "0", status: null },
];

export function suggestQuestion(line: Line): string {
  return `Pouvez-vous préciser le détail de la ligne « ${line.desc} » ? (montant ${line.totalHt} € HT)`;
}

export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f5f6f7] p-5 flex items-start justify-center">
      <div className="w-full max-w-[1200px]">{children}</div>
    </div>
  );
}

export function CardHeader() {
  return (
    <div className="bg-white rounded-[1.5rem] border-2 border-[#0B2545]/40 shadow-[0_2px_8px_rgba(11,37,69,0.08)] p-4">
      <div className="flex items-center gap-3">
        <ChevronDown size={14} className="text-neutral-700" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] font-black tracking-tight" style={{ color: NAVY }}>{SAMPLE.code}</span>
            <span className="text-[11px] text-neutral-500">N° {SAMPLE.number}</span>
          </div>
          <p className="text-[12px] text-neutral-900 mt-0.5 truncate">{SAMPLE.description}</p>
          <span className="text-[10px] text-neutral-500">{SAMPLE.contractor}</span>
        </div>
        <div className="pl-4 border-l-2 border-[#0B2545]/20 min-w-[10rem] text-right tabular-nums">
          <div className="text-[16px] font-black tracking-tight leading-none" style={{ color: NAVY }}>{SAMPLE.amountTtc}</div>
          <p className="text-[9px] font-bold uppercase tracking-widest text-neutral-500 mt-1">TTC</p>
          <span className="text-[10px] text-neutral-500">{SAMPLE.amountHt} HT</span>
        </div>
      </div>
    </div>
  );
}

export function StatusButtons({
  status,
  onChange,
  badge,
  redRef,
}: {
  status: LineStatus;
  onChange: (s: LineStatus) => void;
  badge?: React.ReactNode;
  redRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        title="Validé"
        onClick={() => onChange(status === "green" ? null : "green")}
        className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${
          status === "green" ? "bg-emerald-500 border-emerald-600" : "border-emerald-400 hover:bg-emerald-50"
        }`}
      >
        {status === "green" && <span className="text-white text-[9px] font-bold">✓</span>}
      </button>
      <button
        type="button"
        title="À vérifier"
        onClick={() => onChange(status === "amber" ? null : "amber")}
        className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${
          status === "amber" ? "bg-amber-500 border-amber-600" : "border-amber-400 hover:bg-amber-50"
        }`}
      >
        {status === "amber" && <span className="text-white text-[9px] font-bold">?</span>}
      </button>
      <button
        ref={redRef}
        type="button"
        title="Rejeté — créer une question"
        onClick={() => onChange(status === "red" ? null : "red")}
        className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors relative ${
          status === "red" ? "bg-rose-500 border-rose-600 ring-2 ring-rose-300" : "border-rose-400 hover:bg-rose-50"
        }`}
      >
        {status === "red" && <span className="text-white text-[9px] font-bold">✕</span>}
        {badge && <span className="absolute -top-1 -right-1">{badge}</span>}
      </button>
      <button
        type="button"
        title="Notes"
        className="w-5 h-5 rounded-md border border-neutral-200 text-neutral-400 flex items-center justify-center"
      >
        <FileText size={9} />
      </button>
    </div>
  );
}

export function rowTint(status: LineStatus): string {
  if (status === "red") return "bg-rose-50/40 border-l-[3px] border-rose-300";
  if (status === "amber") return "bg-amber-50/40 border-l-[3px] border-amber-300";
  if (status === "green") return "bg-emerald-50/30 border-l-[3px] border-emerald-300";
  return "border-l-[3px] border-transparent";
}

export function LineItemsHeader({ count }: { count: number }) {
  return (
    <div className="flex items-center justify-between mb-1.5">
      <h4 className="text-[12px] font-black uppercase tracking-tight">Lignes du devis ({count})</h4>
      <p className="text-[10px] text-neutral-500">Cliquez ✕ sur une ligne pour poser une question à l'entreprise</p>
    </div>
  );
}
