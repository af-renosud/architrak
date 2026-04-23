import "./_group.css";
import { useState } from "react";
import {
  PageShell, CardHeader, DetailBody, SignOffSection, SignOffStepper,
  FinancialCards, ProgressBar, LineItemsTable, TranslationBlock,
  AvenantsBlock, InvoicesBlock, SAMPLE,
} from "./_shared";
import { ListOrdered, Languages, FilePlus2, Receipt } from "lucide-react";

type TabKey = "lines" | "translation" | "avenants" | "invoices";

const TABS: { key: TabKey; label: string; icon: React.ElementType; count: number; meta?: string }[] = [
  { key: "lines", label: "Line Items", icon: ListOrdered, count: SAMPLE.lineItems.length, meta: SAMPLE.amountHt + " HT" },
  { key: "translation", label: "Translation", icon: Languages, count: SAMPLE.translatedLines, meta: "DRAFT" },
  { key: "avenants", label: "Avenants", icon: FilePlus2, count: SAMPLE.avenants.length },
  { key: "invoices", label: "Invoices", icon: Receipt, count: SAMPLE.invoices.length },
];

export function TabbedAdvanced() {
  const [active, setActive] = useState<TabKey>("lines");

  return (
    <PageShell>
      <CardHeader />
      <DetailBody>
        <SignOffSection />
        <SignOffStepper />
        <FinancialCards />
        <ProgressBar />

        <div className="rounded-2xl border border-[#0B2545]/15 bg-white overflow-hidden">
          <div className="flex items-center border-b border-black/5 px-2 bg-[#0B2545]/[0.03]">
            {TABS.map((t) => {
              const isActive = t.key === active;
              const Icon = t.icon;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setActive(t.key)}
                  className={`relative inline-flex items-center gap-2 px-3 py-2.5 text-[11px] font-bold uppercase tracking-widest transition-colors
                    ${isActive ? "text-[#0B2545]" : "text-neutral-500 hover:text-neutral-700"}`}
                >
                  <Icon size={13} />
                  <span>{t.label}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded ${isActive ? "bg-[#0B2545] text-white" : "bg-neutral-200 text-neutral-700"}`}>
                    {t.count}
                  </span>
                  {t.meta && (
                    <span className="text-[9px] font-semibold normal-case tracking-normal text-neutral-400 ml-1">{t.meta}</span>
                  )}
                  {isActive && <span className="absolute left-2 right-2 -bottom-px h-[2px] bg-[#0B2545] rounded" />}
                </button>
              );
            })}
          </div>

          <div className="p-4">
            {active === "lines" && <LineItemsTable />}
            {active === "translation" && <TranslationBlock />}
            {active === "avenants" && <AvenantsBlock />}
            {active === "invoices" && <InvoicesBlock />}
          </div>
        </div>
      </DetailBody>
    </PageShell>
  );
}
