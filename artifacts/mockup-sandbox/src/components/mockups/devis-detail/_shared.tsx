import { useState } from "react";
import {
  ChevronDown, ChevronRight, FileText, Receipt, FilePlus2,
  Plus, Upload, ArrowUpRight, ArrowDownRight, AlertTriangle, Ban,
  Languages, CheckCircle2, ShieldCheck,
} from "lucide-react";

export const NAVY = "#0B2545";

export const SAMPLE = {
  code: "DVP0000580",
  number: "DVP0000580",
  description: "Aménagement Piscine — Chantier Renosud / Villa Sophia",
  contractor: "AT PISCINES",
  amountTtc: "49 183,27 €",
  amountHt: "40 986,06 €",
  adjustedTtc: "51 683,27 €",
  adjustedHt: "43 086,06 €",
  invoicedTtc: "18 000,00 €",
  invoicedHt: "15 000,00 €",
  remainingTtc: "33 683,27 €",
  remainingHt: "28 086,06 €",
  progress: 35,
  mode: "B",
  status: "PENDING",
  lotCode: "LOT3",
  lotName: "Piscine et terrasse",
  worksUk: "Pool installation and surrounding terracing works",
  lineItems: [
    { n: 1, desc: "Préparation du terrain et terrassement", qty: "1", unit: "ft", unitHt: "3 200,00", totalHt: "3 200,00", pct: "100" },
    { n: 2, desc: "Bassin béton 8m × 4m × 1.5m, structure renforcée", qty: "1", unit: "u", unitHt: "18 500,00", totalHt: "18 500,00", pct: "60" },
    { n: 3, desc: "Local technique + raccordements hydrauliques", qty: "1", unit: "u", unitHt: "4 800,00", totalHt: "4 800,00", pct: "30" },
    { n: 4, desc: "Margelles pierre reconstituée — pose comprise", qty: "32", unit: "ml", unitHt: "85,00", totalHt: "2 720,00", pct: "0" },
    { n: 5, desc: "Liner armé 150/100 — coloris sable", qty: "60", unit: "m²", unitHt: "78,00", totalHt: "4 680,00", pct: "0" },
    { n: 6, desc: "Système de filtration + traitement automatique", qty: "1", unit: "u", unitHt: "3 200,00", totalHt: "3 200,00", pct: "0" },
    { n: 7, desc: "Éclairage LED submersible (4 spots)", qty: "4", unit: "u", unitHt: "210,00", totalHt: "840,00", pct: "0" },
    { n: 8, desc: "Volet roulant immergé motorisé", qty: "1", unit: "u", unitHt: "3 046,06", totalHt: "3 046,06", pct: "0" },
  ],
  translationStatus: "draft" as "missing" | "draft" | "edited" | "finalised",
  translatedLines: 6,
  totalLines: 8,
  avenants: [
    { type: "pv" as const, desc: "Plus-value : volet motorisé renforcé", amount: "+ 1 800,00 €", status: "APPROVED" },
    { type: "mv" as const, desc: "Moins-value : margelles standard", amount: "- 300,00 €", status: "APPROVED" },
  ],
  invoices: [
    { number: "FA-2026-0042", cert: "CP-001", amount: "12 000,00 €", status: "PAID" },
    { number: "FA-2026-0061", cert: "CP-002", amount: "6 000,00 €", status: "CERTIFIED" },
  ],
};

const SIGN_OFF_STAGES = [
  { key: "received", label: "Received" },
  { key: "checked_internal", label: "Checked Internally" },
  { key: "approved_for_signing", label: "Approved for Signing" },
  { key: "sent_to_client", label: "Sent to Client" },
  { key: "client_signed_off", label: "Client Signed Off" },
];
const CURRENT_STAGE_INDEX = 2;

export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="devis-detail-shell min-h-screen bg-[#f5f6f7] p-6 flex items-start justify-center">
      <div className="w-full max-w-[1200px]">{children}</div>
    </div>
  );
}

export function CardHeader() {
  return (
    <div className="bg-white rounded-[2rem] border-2 border-[#0B2545]/40 shadow-[0_2px_8px_rgba(11,37,69,0.08)] p-5">
      <div className="flex items-center gap-3">
        <ChevronDown size={14} className="text-neutral-700" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[16px] font-black tracking-tight" style={{ color: NAVY }}>{SAMPLE.code}</span>
            <span className="text-[11px] text-neutral-500">N° {SAMPLE.number}</span>
          </div>
          <p className="text-[12px] text-neutral-900 mt-0.5 truncate">{SAMPLE.description}</p>
          <span className="text-[10px] text-neutral-500">{SAMPLE.contractor}</span>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-[8px] font-black uppercase tracking-widest bg-amber-50 text-amber-700 border-amber-200">PENDING</span>
          <span className="h-4 w-px bg-neutral-200" />
          <span className="text-[9px] font-black uppercase tracking-[0.2em] text-neutral-500">Mode</span>
          <span className="text-[11px] font-semibold">B</span>
        </div>
        <div className="pl-4 border-l-2 border-[#0B2545]/20 min-w-[10rem] text-right tabular-nums">
          <div className="text-[18px] font-black tracking-tight leading-none" style={{ color: NAVY }}>{SAMPLE.amountTtc}</div>
          <p className="text-[9px] font-bold uppercase tracking-widest text-neutral-500 mt-1">TTC</p>
          <span className="text-[10px] text-neutral-500">{SAMPLE.amountHt} HT</span>
        </div>
      </div>
    </div>
  );
}

export function DetailBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="ml-4 mt-1 mb-3 border-l-2 border-black/10 pl-4 space-y-4">
      {children}
    </div>
  );
}

export function TechLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`text-[9px] font-black uppercase tracking-[0.2em] text-neutral-500 ${className}`}>
      {children}
    </span>
  );
}

export function SignOffSection() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <TechLabel>Lot Assignment</TechLabel>
          <p className="text-[9px] text-neutral-500">Required for Certificat de Paiement</p>
          <div className="flex items-center justify-between h-9 px-3 rounded-md border border-neutral-200 bg-white">
            <span className="text-[11px] text-neutral-900">{SAMPLE.lotCode} — {SAMPLE.lotName}</span>
            <ChevronDown size={12} className="text-neutral-400" />
          </div>
        </div>
        <div className="space-y-1.5">
          <TechLabel>Works Description (English)</TechLabel>
          <p className="text-[9px] text-neutral-500">Required for Certificat de Paiement</p>
          <div className="relative">
            <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-md bg-[#c1a27b]" />
            <div className="h-9 pl-4 pr-3 flex items-center rounded-md border border-neutral-200 bg-white">
              <span className="text-[11px] text-neutral-900">{SAMPLE.worksUk}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SignOffStepper() {
  return (
    <div className="flex items-center gap-1.5 py-2">
      {SIGN_OFF_STAGES.map((stage, idx) => {
        const isCompleted = idx <= CURRENT_STAGE_INDEX;
        const isCurrent = idx === CURRENT_STAGE_INDEX;
        return (
          <div key={stage.key} className="flex items-center gap-1.5 flex-1">
            <button
              type="button"
              className={`flex-1 px-2 py-1.5 rounded-lg border text-[9px] font-bold uppercase tracking-wide text-center ${
                isCurrent
                  ? "border-[#0B2545] bg-[#0B2545] text-white shadow-sm"
                  : isCompleted
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : "border-slate-200 bg-white text-slate-400"
              }`}
            >
              {stage.label}
            </button>
            {idx < SIGN_OFF_STAGES.length - 1 && (
              <ChevronRight size={10} className={isCompleted && idx < CURRENT_STAGE_INDEX ? "text-emerald-400" : "text-slate-300"} />
            )}
          </div>
        );
      })}
      <button className="h-7 px-2 inline-flex items-center gap-1 ml-2 rounded-md border border-red-200 text-red-500 hover:bg-red-50 shrink-0">
        <Ban size={10} />
        <span className="text-[8px] font-bold uppercase tracking-widest">Void</span>
      </button>
    </div>
  );
}

export function FinancialCards() {
  return (
    <div className="grid grid-cols-4 gap-3">
      <FinCard label="Original Contracted" ttc={SAMPLE.amountTtc} ht={SAMPLE.amountHt} />
      <FinCard label="Adjusted (+ PV/MV)" ttc={SAMPLE.adjustedTtc} ht={SAMPLE.adjustedHt} />
      <FinCard label="Invoiced" ttc={SAMPLE.invoicedTtc} ht={SAMPLE.invoicedHt} amountClass="text-emerald-600" />
      <FinCard label="Reste à Réaliser" ttc={SAMPLE.remainingTtc} ht={SAMPLE.remainingHt} amountClass="text-amber-600" />
    </div>
  );
}

function FinCard({ label, ttc, ht, amountClass = "text-neutral-900" }: { label: string; ttc: string; ht: string; amountClass?: string }) {
  return (
    <div className="p-3 rounded-xl border border-black/5 bg-white/60">
      <TechLabel>{label}</TechLabel>
      <p className={`text-[13px] font-semibold mt-1 ${amountClass}`}>
        {ttc} <span className="text-[9px] text-neutral-500 font-normal">TTC</span>
      </p>
      <p className="text-[10px] text-neutral-500">{ht} HT</p>
    </div>
  );
}

export function ProgressBar() {
  return (
    <div className="h-1.5 w-full rounded-full bg-slate-100">
      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${SAMPLE.progress}%` }} />
    </div>
  );
}

export function LineItemsTable() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-black/10">
            {["#","Description","Qty","Unit Price","Total HT","Progress %"].map((h, i) => (
              <th key={h} className={`py-1 px-2 font-black uppercase tracking-widest text-[8px] ${i === 0 || i === 1 ? "text-left" : "text-right"}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SAMPLE.lineItems.map((li) => (
            <tr key={li.n} className="border-b border-black/5">
              <td className="py-1.5 px-2 text-neutral-500">{li.n}</td>
              <td className="py-1.5 px-2 text-neutral-900">{li.desc}</td>
              <td className="py-1.5 px-2 text-right tabular-nums">{li.qty} {li.unit}</td>
              <td className="py-1.5 px-2 text-right tabular-nums">{li.unitHt}</td>
              <td className="py-1.5 px-2 text-right tabular-nums font-semibold">{li.totalHt}</td>
              <td className="py-1.5 px-2 text-right tabular-nums">
                <span className={li.pct === "100" ? "text-emerald-600" : li.pct === "0" ? "text-neutral-400" : "text-amber-600"}>{li.pct}%</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LineItemsHeader() {
  return (
    <div className="flex items-center justify-between mb-2">
      <h4 className="text-[12px] font-black uppercase tracking-tight">Devis Line Items ({SAMPLE.lineItems.length})</h4>
      <button className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-neutral-200 bg-white">
        <Plus size={12} />
        <span className="text-[8px] font-bold uppercase tracking-widest">Line Item</span>
      </button>
    </div>
  );
}

export function TranslationBlock() {
  return (
    <div className="rounded-xl border border-black/5 bg-white/50 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Languages size={14} className="text-[#0B2545]" />
          <span className="text-[12px] font-black uppercase tracking-tight">English Translation</span>
          <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">DRAFT</span>
        </div>
        <button className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md bg-[#0B2545] text-white">
          <CheckCircle2 size={12} />
          <span className="text-[9px] font-bold uppercase tracking-widest">Approve</span>
        </button>
      </div>
      <p className="text-[10px] text-neutral-500">{SAMPLE.translatedLines} of {SAMPLE.totalLines} lines translated · header complete · ready for review</p>
      <div className="space-y-1 pt-1">
        {SAMPLE.lineItems.slice(0, 3).map((li) => (
          <div key={li.n} className="grid grid-cols-2 gap-3 text-[11px] py-1 border-t border-black/5 first:border-t-0">
            <div className="text-neutral-500">{li.n}. {li.desc}</div>
            <div className="text-neutral-900">{li.n}. (en) {li.desc}</div>
          </div>
        ))}
        <div className="text-[10px] text-neutral-400 pt-1">…and {SAMPLE.lineItems.length - 3} more lines</div>
      </div>
    </div>
  );
}

export function AvenantsBlock() {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-[12px] font-black uppercase tracking-tight">Avenants ({SAMPLE.avenants.length})</h4>
        <button className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-neutral-200 bg-white">
          <Plus size={12} /><span className="text-[8px] font-bold uppercase tracking-widest">Avenant</span>
        </button>
      </div>
      <div className="space-y-2">
        {SAMPLE.avenants.map((a, i) => (
          <div key={i} className="flex items-center justify-between p-2 rounded-xl border border-black/5 bg-white/30">
            <div className="flex items-center gap-2">
              {a.type === "pv" ? <ArrowUpRight size={12} className="text-emerald-600" /> : <ArrowDownRight size={12} className="text-rose-500" />}
              <span className="text-[11px]">{a.desc}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-[12px] font-semibold ${a.type === "pv" ? "text-emerald-600" : "text-rose-500"}`}>{a.amount}</span>
              <span className="inline-flex items-center rounded-md border px-1.5 py-0 text-[7px] font-black uppercase tracking-widest bg-emerald-50 text-emerald-700 border-emerald-200">{a.status}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function InvoicesBlock() {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-[12px] font-black uppercase tracking-tight">Invoices ({SAMPLE.invoices.length})</h4>
        <button className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-neutral-200 bg-white">
          <Upload size={12} /><span className="text-[8px] font-bold uppercase tracking-widest">Upload Invoice</span>
        </button>
      </div>
      <div className="space-y-2">
        {SAMPLE.invoices.map((inv, i) => (
          <div key={i} className="flex items-center justify-between p-2 rounded-xl border border-black/5 bg-white/30">
            <div className="flex items-center gap-2">
              <FileText size={12} className="text-neutral-500" />
              <span className="text-[11px]">Invoice #{inv.number}</span>
              <TechLabel>Cert: {inv.cert}</TechLabel>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-semibold">{inv.amount}</span>
              <span className="inline-flex items-center rounded-md border px-1.5 py-0 text-[7px] font-black uppercase tracking-widest bg-emerald-50 text-emerald-700 border-emerald-200">{inv.status}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CollapsibleSection({
  icon: Icon,
  title,
  meta,
  children,
  defaultOpen = false,
  accent,
}: {
  icon: React.ElementType;
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  accent?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`rounded-xl border ${open ? "border-[#0B2545]/20 bg-white" : "border-black/5 bg-white/40"} overflow-hidden`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-black/[.02]"
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? <ChevronDown size={14} className="text-neutral-700 shrink-0" /> : <ChevronRight size={14} className="text-neutral-700 shrink-0" />}
          <Icon size={14} className="text-[#0B2545] shrink-0" />
          <span className="text-[12px] font-black uppercase tracking-tight truncate">{title}</span>
          {accent && (
            <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-[#0B2545]/10 text-[#0B2545]">{accent}</span>
          )}
        </div>
        {meta && <div className="shrink-0">{meta}</div>}
      </button>
      {open && <div className="px-3 pb-3 pt-1">{children}</div>}
    </div>
  );
}

export { ChevronDown, ChevronRight, FileText, Languages };
