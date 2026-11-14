import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { QuotationVersionGroup as VersionGroup, VersionedQuotation } from "./quotation-version-groups";

/** Lazy-mount historical rows on first reveal, then retain hidden editor state. */
export function QuotationVersionGroup<T extends VersionedQuotation>({
  group, renderRow, revealKey = "",
}: {
  group: VersionGroup<T>;
  renderRow: (row: T, historical: boolean) => ReactNode;
  /** Changes on a new matched search/filter or direct-link destination. */
  revealKey?: string;
}) {
  const [disclosure, setDisclosure] = useState<{ key: string; open: boolean } | null>(null);
  const open = disclosure?.key === revealKey ? disclosure.open : !!revealKey;
  const [hasRevealed, setHasRevealed] = useState(open);
  useEffect(() => {
    if (open) setHasRevealed(true);
  }, [open]);
  const regionId = `quotation-previous-${group.current.id}`;
  return (
    <div className="min-w-0" data-testid={`quotation-version-group-${group.current.id}`}>
      {renderRow(group.current, false)}
      {group.previous.length > 0 && (
        <div className="mt-2 rounded-lg border border-border bg-muted/20">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={regionId}
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-xs font-semibold hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={() => setDisclosure({ key: revealKey, open: !open })}
          >
            {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            Previous versions ({group.previous.length})
          </button>
          <div id={regionId} hidden={!open}>
            {(open || hasRevealed) && (
              <div className="space-y-3 border-t border-border px-2 py-3 sm:px-4">
                <p className="text-xs text-muted-foreground">
                  Replaced—not current. Original records, PDFs and replacement history remain available here, including void previous versions.
                </p>
                {group.previous.map(row => (
                  <div key={row.id}>{renderRow(row, true)}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
