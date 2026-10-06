import { useId, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { useInvoiceDescription } from "./use-invoice-description";

export function PennylaneInvoiceDescription({ certId }: { certId: number }) {
  return <InvoiceDescription key={certId} certId={certId} />;
}

function InvoiceDescription({ certId }: { certId: number }) {
  const query = useInvoiceDescription(certId);
  const titleId = useId();
  const paragraph = useRef<HTMLParagraphElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "pending" | "success" | "failure" | "selected">("idle");

  async function copyDescription() {
    if (!query.data || query.isFetching) return;
    setCopyState("pending");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(query.data.description);
      setCopyState("success");
    } catch {
      setCopyState("failure");
    }
  }

  function selectDescription() {
    const element = paragraph.current;
    const selection = window.getSelection();
    if (!element || !selection) return;
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    setCopyState("selected");
  }

  return (
    <section aria-labelledby={titleId} className="space-y-3 rounded-xl border border-border p-4" data-testid={`pennylane-invoice-description-${certId}`}>
      <div className="flex items-center gap-2">
        <Copy size={13} aria-hidden="true" />
        <TechnicalLabel id={titleId}>Description pour Pennylane</TechnicalLabel>
      </div>
      <p className="text-[11px] text-muted-foreground">Description en anglais à copier dans votre facture. Aucun montant ni document n’est modifié.</p>
      {query.isFetching ? (
        <div role="status" aria-label="Chargement de la description" className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      ) : query.isError ? (
        <div className="space-y-2">
          <p role="alert" className="text-[11px] text-destructive">Impossible de charger la description. {query.error.message}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>Réessayer</Button>
        </div>
      ) : query.data ? (
        <>
          <p ref={paragraph} tabIndex={0} aria-label="Description de la facture en anglais" lang="en" className="select-text whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-[11px] leading-relaxed outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
            {query.data.description}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={copyState === "pending"} onClick={() => void copyDescription()}>
              <Copy size={12} aria-hidden="true" />{copyState === "pending" ? "Copie en cours…" : "Copier la description"}
            </Button>
            {(copyState === "failure" || copyState === "selected") && (
              <Button type="button" variant="ghost" size="sm" onClick={selectDescription}>Sélectionner le texte</Button>
            )}
          </div>
        </>
      ) : null}
      <p role="status" aria-live="polite" aria-atomic="true" className="text-[11px] text-muted-foreground">
        {!query.isFetching && !query.isError && (
          copyState === "success" ? "Description copiée." :
          copyState === "failure" ? "La copie automatique a échoué. Sélectionnez le texte, puis utilisez Ctrl+C ou Cmd+C, ou la commande Copier de votre appareil." :
          copyState === "selected" ? "Texte sélectionné. Utilisez Ctrl+C ou Cmd+C, ou la commande Copier de votre appareil." : ""
        )}
      </p>
    </section>
  );
}
