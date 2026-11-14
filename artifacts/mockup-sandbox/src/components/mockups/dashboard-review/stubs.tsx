import { useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from "react";
import { dashboardSample, outstandingSample, unsentSample, designActionsSample, stuckMessagesSample, burnupSample, sampleNow, sampleLabel } from "./fixtures";

// Query/auth/provider boundary: synchronous fixture selection, never a request.
export function useQuery<T>({ queryKey }: { queryKey: unknown[]; enabled?: boolean; staleTime?: number; refetchInterval?: number }) {
  const key = queryKey[0];
  let data: unknown;
  if (key === "/api/dashboard/summary") data = dashboardSample;
  else if (key === "/api/fees/outstanding") data = outstandingSample;
  else if (key === "/api/auth/user") data = { id: 1, email: "illustrative@example.invalid", gmailLinked: true, gmailLastPollAt: sampleNow };
  else if (key === "/api/gmail/status") data = { pollHealth: { level: "healthy", ageMs: 0, message: null }, needsAttentionCount: 2, persistentFailureCount: 1 };
  else if (key === "/api/architect-fee-invoices") data = [{ id: 1 }, { id: 2 }];
  else if (key === "/api/design-contracts/dashboard-actions") data = designActionsSample;
  else if (key === "/api/certificats/unsent") data = unsentSample;
  else if (key === "/api/gmail/stuck-messages") data = stuckMessagesSample;
  else if (key === "/api/pennylane/feature-flags") data = { configured: true, pushEnabled: false, dryRun: true };
  else if (key === "/api/projects" && queryKey[2] === "burn-up") data = burnupSample(Number(queryKey[1]));
  else throw new Error(`No illustrative fixture registered for ${JSON.stringify(queryKey)}`);
  return { data: data as T, isLoading: false, refetch: () => undefined };
}

export function sandboxNotice(action: string) {
  window.dispatchEvent(new CustomEvent("dashboard-sandbox-notice", { detail: `${action} — illustration only. No data changed and no service contacted.` }));
}
export function Link({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} href="#" data-original-href={href} onClick={(event) => {
    event.preventDefault();
    onClick?.(event);
    sandboxNotice(`Open ${href}`);
  }} />;
}
// Preserves source content/container spacing; navigation shell intentionally omitted.
export function AppLayout({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const listener = (event: Event) => setNotice((event as CustomEvent<string>).detail);
    window.addEventListener("dashboard-sandbox-notice", listener);
    return () => window.removeEventListener("dashboard-sandbox-notice", listener);
  }, []);
  return <div className="dashboard-review min-h-screen min-w-0 bg-background text-foreground">
    <main className="min-w-0 flex-1 overflow-x-hidden">
      <div className="mx-auto max-w-[1600px] p-4 pt-16 sm:p-6 sm:pt-16 lg:p-8">
        <p className="mb-4 text-[10px] text-muted-foreground" role="note">{sampleLabel}</p>
        {children}
      </div>
    </main>
    {notice && <div role="status" className="fixed bottom-4 right-4 z-[100] max-w-sm rounded-lg border border-border bg-card p-4 text-xs shadow-lg" onClick={() => setNotice("")}>{notice}</div>}
  </div>;
}
