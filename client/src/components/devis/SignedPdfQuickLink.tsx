import { FileCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function SignedPdfQuickLink({ devisId, available }: { devisId: number; available: boolean }) {
  if (!available) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="outline" size="icon"
          className="h-8 w-8 border-2 border-green-600 bg-green-50 text-green-700 hover:bg-green-100 hover:text-green-800">
          <a href={`/api/devis/${devisId}/signed-pdf`} target="_blank" rel="noopener noreferrer"
            aria-label="View signed PDF" data-testid={`button-view-signed-pdf-${devisId}`}
            onClick={(event) => event.stopPropagation()}>
            <FileCheck size={13} />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[10px]">View signed PDF</TooltipContent>
    </Tooltip>
  );
}
