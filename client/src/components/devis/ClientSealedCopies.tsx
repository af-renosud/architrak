import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

type ClientRelease = {
  id: number;
  reason: "publish" | "update" | "client_link" | "backfill";
  sealedAt: string;
  sealedBy: string | null;
  current: boolean;
  hasPackage: boolean;
  packageSha256: string | null;
  packageBytes: number | null;
  hasOriginal: boolean;
  originalSha256: string | null;
  translationShown: boolean;
};

export type ClientCopySummary = { count: number; outdated: boolean; clientVisible: boolean };

type ClientReleasesResponse = {
  clientVisible: boolean;
  outdated: boolean;
  releases: ClientRelease[];
};

const REASON_LABELS: Record<ClientRelease["reason"], string> = {
  publish: "Shared on the project link",
  update: "Client copy updated",
  client_link: "Sent as a client link",
  backfill: "Sealed when this feature was introduced (earlier views not recorded)",
};

const formatDate = (value: string) =>
  new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Paris" });

/**
 * Sealed, unchangeable copies of exactly what the client has been shown
 * for this quotation, with downloads of the exact sealed files.
 */
export function ClientSealedCopies({ devisId, isArchived, summary, onUpdated }: {
  devisId: number;
  isArchived: boolean;
  /** From the project-level share state — no per-card request while collapsed. */
  summary: ClientCopySummary | undefined;
  onUpdated: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const queryKey = ["/api/devis", devisId, "client-releases"];
  const { data } = useQuery<ClientReleasesResponse>({ queryKey, enabled: open && !!summary });

  const updateMutation = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/devis/${devisId}/client-releases/update`)).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      onUpdated();
      toast({ title: "Client copy updated", description: "The client now sees the newly sealed version. Earlier copies remain on record." });
    },
    onError: (error: Error) => toast({ title: "Could not update the client copy", description: error.message, variant: "destructive" }),
  });

  if (!summary || summary.count === 0) return null;
  const base = `/api/devis/${devisId}/client-releases`;

  return (
    <div className="space-y-1 pt-1" data-testid={`section-client-sealed-copies-${devisId}`}>
      {summary.outdated && summary.clientVisible && (
        <div className="max-w-sm rounded border border-amber-300 bg-amber-50 p-1.5 text-[10px] text-amber-900" data-testid={`text-client-copy-outdated-${devisId}`}>
          <p>The client is still seeing the earlier sealed version. Your later edits are not visible to them.</p>
          {!isArchived && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1 h-7 text-[10px] border-amber-400"
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending}
              data-testid={`button-update-client-copy-${devisId}`}
            >
              {updateMutation.isPending ? "Sealing new copy…" : "Update the client's copy"}
            </Button>
          )}
        </div>
      )}
      <button
        type="button"
        className="text-[10px] font-semibold text-[#0B2545] underline underline-offset-2"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        data-testid={`button-toggle-client-copies-${devisId}`}
      >
        {open ? "Hide" : "Show"} sealed client copies ({summary.count})
      </button>
      {open && !data && <p className="text-[10px] text-muted-foreground">Loading sealed copies…</p>}
      {open && data && (
        <ul className="max-w-md space-y-1.5" data-testid={`list-client-copies-${devisId}`}>
          {data.releases.map(r => (
            <li key={r.id} className="rounded border border-slate-200 bg-white p-1.5 text-[10px]" data-testid={`item-client-copy-${r.id}`}>
              <p className="font-semibold text-[#0B2545]">
                {formatDate(r.sealedAt)}{r.current ? " · what the client sees now" : ""}
              </p>
              <p className="text-muted-foreground">
                {REASON_LABELS[r.reason]}{r.sealedBy ? ` by ${r.sealedBy}` : ""}
                {r.translationShown ? "" : " · English translation not yet shown"}
              </p>
              <div className="mt-1 flex flex-wrap gap-2">
                {r.hasPackage && (
                  <a className="underline" href={`${base}/${r.id}/package.pdf`} target="_blank" rel="noopener" data-testid={`link-client-copy-package-${r.id}`}>
                    Complete package (EN + FR)
                  </a>
                )}
                {r.hasOriginal && (
                  <a className="underline" href={`${base}/${r.id}/original.pdf`} target="_blank" rel="noopener" data-testid={`link-client-copy-original-${r.id}`}>
                    Original French PDF
                  </a>
                )}
              </div>
              {r.packageSha256 && (
                <p className="mt-0.5 break-all font-mono text-[9px] text-slate-500" title="SHA-256 fingerprint of the sealed package">
                  SHA-256 {r.packageSha256}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
