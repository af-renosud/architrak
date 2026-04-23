import "./_group.css";
import {
  PageShell, CardHeader, DetailBody, SignOffSection, SignOffStepper,
  FinancialCards, ProgressBar, LineItemsTable, TranslationBlock,
  AvenantsBlock, InvoicesBlock, CollapsibleSection, SAMPLE,
} from "./_shared";
import { ListOrdered, Languages } from "lucide-react";

export function InlineCollapse() {
  return (
    <PageShell>
      <CardHeader />
      <DetailBody>
        <SignOffSection />
        <SignOffStepper />
        <FinancialCards />
        <ProgressBar />

        <CollapsibleSection
          icon={ListOrdered}
          title="Devis Line Items"
          defaultOpen={false}
          meta={
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-neutral-500">{SAMPLE.lineItems.length} items</span>
              <span className="text-[11px] font-bold text-[#0B2545] tabular-nums">{SAMPLE.amountHt} HT</span>
            </div>
          }
        >
          <LineItemsTable />
        </CollapsibleSection>

        <CollapsibleSection
          icon={Languages}
          title="English Translation"
          accent="DRAFT"
          defaultOpen={false}
          meta={
            <span className="text-[10px] text-neutral-500">{SAMPLE.translatedLines}/{SAMPLE.totalLines} lines</span>
          }
        >
          <TranslationBlock />
        </CollapsibleSection>

        <AvenantsBlock />
        <InvoicesBlock />
      </DetailBody>
    </PageShell>
  );
}
