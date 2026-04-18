import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ShieldAlert, FileText, ClipboardList, Award } from "lucide-react";

export interface RetainedRecordCounts {
  invoices: number;
  situations: number;
  certificats: number;
}

interface RetentionBlockedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName?: string;
  retained: RetainedRecordCounts | null;
}

export function RetentionBlockedDialog({ open, onOpenChange, projectName, retained }: RetentionBlockedDialogProps) {
  const counts = retained ?? { invoices: 0, situations: 0, certificats: 0 };
  const rows: Array<{ key: keyof RetainedRecordCounts; label: string; icon: typeof FileText }> = [
    { key: "invoices", label: "Factures", icon: FileText },
    { key: "situations", label: "Situations de travaux", icon: ClipboardList },
    { key: "certificats", label: "Certificats de paiement", icon: Award },
  ];
  const visibleRows = rows.filter((r) => counts[r.key] > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="dialog-retention-blocked">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-50 text-amber-600 dark:bg-amber-950 dark:text-amber-400">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <DialogTitle className="text-[16px] font-black uppercase tracking-tight" data-testid="text-retention-title">
              Suppression impossible
            </DialogTitle>
          </div>
          <DialogDescription className="pt-2 text-[12px] leading-relaxed text-muted-foreground" data-testid="text-retention-description">
            {projectName ? (
              <>Le projet <span className="font-semibold text-foreground">{projectName}</span> ne peut pas être supprimé.</>
            ) : (
              <>Ce projet ne peut pas être supprimé.</>
            )}
            {" "}
            La loi française (Code de commerce, article L123-22) impose la conservation des pièces comptables pendant 10 ans.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
            Documents encore liés à ce projet
          </p>
          <ul className="divide-y divide-border rounded-lg border border-border" data-testid="list-retained-records">
            {visibleRows.length === 0 ? (
              <li className="px-3 py-2 text-[12px] text-muted-foreground">Aucun détail disponible.</li>
            ) : (
              visibleRows.map(({ key, label, icon: Icon }) => (
                <li key={key} className="flex items-center justify-between gap-3 px-3 py-2" data-testid={`row-retained-${key}`}>
                  <span className="flex items-center gap-2 text-[12px] text-foreground">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    {label}
                  </span>
                  <span className="text-[12px] font-semibold text-foreground tabular-nums" data-testid={`count-retained-${key}`}>
                    {counts[key]}
                  </span>
                </li>
              ))
            )}
          </ul>
        </div>

        <div className="rounded-lg bg-slate-50 p-3 text-[11px] leading-relaxed text-muted-foreground dark:bg-slate-900">
          <p className="font-semibold text-foreground mb-1">Que faire ensuite ?</p>
          <p>
            Vous pouvez archiver le projet pour le retirer de la liste active tout en conservant ses documents comptables.
            Pensez aussi à transférer ou exporter les pièces avant toute action définitive.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-retention-close">
            <span className="text-[9px] font-bold uppercase tracking-widest">J'ai compris</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
