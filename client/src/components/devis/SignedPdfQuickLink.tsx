import { FileCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function SignedPdfQuickLink({ devisId, available, signed = available }: { devisId: number; available: boolean; signed?: boolean }) {
  const isSigned = signed || available;
  const label = !isSigned ? "Not yet signed" : !available ? "Signed — signed PDF not yet available" : "View signed PDF";
  const className = `h-8 w-8 border-2 ${isSigned
    ? "border-green-600 bg-green-50 text-green-700 hover:bg-green-100 hover:text-green-800"
    : "border-slate-300 bg-slate-100 text-slate-400 hover:bg-slate-100 hover:text-slate-400"}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {available ? (
        <Button asChild variant="outline" size="icon"
          className={className}>
          <a href={`/api/devis/${devisId}/signed-pdf`} target="_blank" rel="noopener noreferrer"
            aria-label="View signed PDF" data-testid={`button-view-signed-pdf-${devisId}`}
            onClick={(event) => event.stopPropagation()}>
            <FileCheck size={13} />
          </a>
        </Button>
        ) : (
          <Button type="button" variant="outline" size="icon" className={className}
            aria-disabled="true" aria-label={label}
            data-testid={`button-view-signed-pdf-${devisId}`}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
            <FileCheck size={13} />
          </Button>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[10px]">{label}</TooltipContent>
    </Tooltip>
  );
}
