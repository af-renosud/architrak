import "./_group.css";
import {
  PageShell, CardHeader, DetailBody, SignOffSection, SignOffStepper,
  FinancialCards, ProgressBar, LineItemsHeader, LineItemsTable,
  TranslationBlock, AvenantsBlock, InvoicesBlock,
} from "./_shared";

export function Current() {
  return (
    <PageShell>
      <CardHeader />
      <DetailBody>
        <SignOffSection />
        <SignOffStepper />
        <FinancialCards />
        <ProgressBar />

        <div>
          <LineItemsHeader />
          <LineItemsTable />
        </div>

        <TranslationBlock />

        <AvenantsBlock />
        <InvoicesBlock />
      </DetailBody>
    </PageShell>
  );
}
