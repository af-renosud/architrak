import "./_group.css";
import { useState } from "react";
import {
  PageShell, CardHeader, DetailBody, SignOffSection, SignOffStepper,
  FinancialCards, ProgressBar, LineItemsTable, TranslationBlock,
  AvenantsBlock, InvoicesBlock, SAMPLE, NAVY,
} from "./_shared";
import { ChevronDown, ChevronRight, ListOrdered, Languages, Plus } from "lucide-react";

function PeekBar({
  icon: Icon,
  title,
  summary,
  children,
  open,
  onToggle,
}: {
  icon: React.ElementType;
  title: string;
  summary: React.ReactNode;
  children: React.ReactNode;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`rounded-xl border ${open ? "border-[#0B2545]/30 bg-white" : "border-black/5 bg-white/40"} overflow-hidden`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-black/[.02]"
      >
        {open ? <ChevronDown size={14} className="text-neutral-700 shrink-0" /> : <ChevronRight size={14} className="text-neutral-700 shrink-0" />}
        <Icon size={14} className="shrink-0" style={{ color: NAVY }} />
        <span className="text-[12px] font-black uppercase tracking-tight">{title}</span>
        <span className="h-4 w-px bg-neutral-200" />
        <div className="flex-1 min-w-0 text-left">{summary}</div>
      </button>
      {open && <div className="px-3 pb-3 pt-1 border-t border-black/5">{children}</div>}
    </div>
  );
}

export function PeekBars() {
  const [openLines, setOpenLines] = useState(false);
  const [openTr, setOpenTr] = useState(false);

  const lineSummary = (
    <div className="flex items-center gap-4 text-[11px]">
      <span className="text-neutral-500">{SAMPLE.lineItems.length} items</span>
      <span className="text-neutral-300">·</span>
      <span className="text-neutral-700 truncate">{SAMPLE.lineItems[0].desc}, {SAMPLE.lineItems[1].desc}…</span>
      <span className="ml-auto font-semibold text-[#0B2545] tabular-nums shrink-0">{SAMPLE.amountHt} HT</span>
    </div>
  );

  const translationSummary = (
    <div className="flex items-center gap-3 text-[11px]">
      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[9px] font-bold uppercase tracking-widest">DRAFT</span>
      <span className="text-neutral-700 tabular-nums">{SAMPLE.translatedLines}/{SAMPLE.totalLines} lines</span>
      <span className="text-neutral-300">·</span>
      <span className="text-neutral-500 truncate">Header complete · ready for review</span>
      <span className="ml-auto text-[10px] font-bold uppercase tracking-widest text-[#0B2545] shrink-0">Approve →</span>
    </div>
  );

  return (
    <PageShell>
      <CardHeader />
      <DetailBody>
        <SignOffSection />
        <SignOffStepper />
        <FinancialCards />
        <ProgressBar />

        <PeekBar
          icon={ListOrdered}
          title="Line Items"
          summary={lineSummary}
          open={openLines}
          onToggle={() => setOpenLines((v) => !v)}
        >
          <div className="flex justify-end mb-2">
            <button className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-neutral-200 bg-white">
              <Plus size={12} /><span className="text-[8px] font-bold uppercase tracking-widest">Line Item</span>
            </button>
          </div>
          <LineItemsTable />
        </PeekBar>

        <PeekBar
          icon={Languages}
          title="Translation"
          summary={translationSummary}
          open={openTr}
          onToggle={() => setOpenTr((v) => !v)}
        >
          <TranslationBlock />
        </PeekBar>

        <AvenantsBlock />
        <InvoicesBlock />
      </DetailBody>
    </PageShell>
  );
}
