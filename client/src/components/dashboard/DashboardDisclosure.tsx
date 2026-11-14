import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/** Hide, rather than unmount, content so edits and dialog owners survive a toggle. */
export function DashboardDisclosure({
  title, summary, count, defaultOpen = false, priority = false, issue, children,
}: {
  title: string;
  summary: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  priority?: boolean;
  issue?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className={`overflow-hidden rounded-lg border bg-card ${priority ? "border-t-[3px] border-t-amber-700" : "border-border"}`}>
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-3 p-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-[-3px]"
        >
          {count !== undefined && <span className="flex h-7 min-w-7 shrink-0 items-center justify-center rounded bg-muted px-1.5 text-xs tabular-nums">{count}</span>}
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold text-foreground">{title}</span>
            <span className="mt-1 block text-[11px] font-normal text-muted-foreground">{summary}</span>
          </span>
          <ChevronDown size={16} aria-hidden="true" className={`shrink-0 text-muted-foreground ${open ? "rotate-180" : ""}`} />
        </button>
      </h3>
      {issue && <div className="border-t border-border px-4 py-2">{issue}</div>}
      <div id={id} hidden={!open} className="border-t border-border p-3 sm:p-4">{children}</div>
    </section>
  );
}

export function DashboardQueryState({ loading, error, retry }: { loading?: boolean; error?: Error | null; retry: () => unknown }) {
  if (error) return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
      <span>Unable to load: {error.message}</span>
      <button type="button" onClick={() => retry()} className="underline underline-offset-2">Retry</button>
    </div>
  );
  return loading ? <p role="status" className="text-xs text-muted-foreground">Loading…</p> : null;
}
