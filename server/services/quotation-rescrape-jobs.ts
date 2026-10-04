import { rescrapeDevis } from "./devis-rescrape.service";

const running = new Set<number>();
export const isQuotationRescrapeRunning = (id: number) => running.has(id);
/** No source data lives only in this registry. Before a committed replacement,
 * interruption leaves the original unchanged; successful/failed results are
 * append-only database events, not process-local messages. */
export function startQuotationRescrape(id: number) {
  if (running.has(id)) return;
  running.add(id);
  void rescrapeDevis(id).catch(() => console.error("[QuotationRescrape] Source check failed; original content preserved"))
    .finally(() => running.delete(id));
}