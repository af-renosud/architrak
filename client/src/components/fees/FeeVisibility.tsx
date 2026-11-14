import { useState } from "react";
import type { FeeVisibilityRecord, FeeVisibilityEvent } from "@shared/fee-visibility";
import type { Project } from "@shared/schema";
import { useChangeFeeVisibility, useFeeVisibility } from "@/hooks/use-fee-visibility";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

export function FeeVisibilityAction({ projectId, record }: { projectId: string; record?: FeeVisibilityRecord }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const change = useChangeFeeVisibility(projectId);
  if (!record) return <span className="text-xs text-destructive">Visibility unavailable</span>;
  const action = record.archived ? "restore" : "archive";
  return <div className="space-y-1">
    <Button size="sm" variant="outline" disabled={!record.archived && !!record.blockedReason} onClick={() => { change.reset(); setOpen(true); }}>
      {record.archived ? "Restore" : "Archive"} {record.kind}
    </Button>
    {record.archived && <p className="text-xs text-muted-foreground">Archived · {record.reason}</p>}
    {record.blockedReason && <p className="max-w-sm text-xs text-muted-foreground">Cannot archive: {record.blockedReason}</p>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{record.archived ? "Restore" : "Archive"} {record.kind} #{record.id}</DialogTitle>
          <DialogDescription>Visibility only. Amounts, original documents and audit history are retained. Archiving does not prove payment.</DialogDescription>
        </DialogHeader>
        <label className="text-sm" htmlFor={`visibility-reason-${record.kind}-${record.id}`}>Reason (required)</label>
        <Textarea id={`visibility-reason-${record.kind}-${record.id}`} value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} />
        {change.error && <p role="alert" className="text-sm text-destructive">{change.error.message}</p>}
        <Button disabled={!reason.trim() || change.isPending} onClick={() => change.mutate({ kind: record.kind, id: record.id, action, reason }, { onSuccess: () => { setOpen(false); setReason(""); } })}>
          {change.isPending ? "Saving…" : `Confirm ${action}`}
        </Button>
      </DialogContent>
    </Dialog>
  </div>;
}
export function FeeHistory({ events }: { events: FeeVisibilityEvent[] }) {
  return <section className="rounded-lg border p-5 space-y-4">
    <h2 className="text-sm font-semibold">Archive & restore audit</h2>
    <p className="text-xs text-muted-foreground">Visibility decisions, not a payment ledger. Original accounting documents remain the evidence.</p>
    {!events.length && <p className="text-sm text-muted-foreground">No archive or restore events recorded for this project.</p>}
    {[...events].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(event => <article key={event.id} className="border-t pt-3 text-sm">
      <p className="font-medium">{event.action === "archive" ? "Archived" : "Restored"} {event.kind} #{event.recordId}</p>
      <p className="break-words">{event.reason}</p>
      <p className="text-xs text-muted-foreground">{event.actor} · {new Date(event.createdAt).toLocaleString()}</p>
    </article>)}
  </section>;
}
function ProjectHistory({ project }: { project: Project }) {
  const visibility = useFeeVisibility(String(project.id));
  return <section className="space-y-2">
    <h2 className="text-sm font-medium">{project.code} — {project.name}</h2>
    {visibility.isLoading ? <Skeleton className="h-20" /> : visibility.error ? <div role="alert" className="text-sm text-destructive">History unavailable: {visibility.error.message} <Button size="sm" variant="outline" onClick={() => visibility.refetch()}>Retry</Button></div> : visibility.data && <FeeHistory events={visibility.data.events} />}
  </section>;
}
export function FeePortfolioHistory({ projects }: { projects: Project[] }) {
  return <div className="space-y-5">{projects.length ? projects.map(project => <ProjectHistory key={project.id} project={project} />) : <p className="text-sm text-muted-foreground">No project history available.</p>}</div>;
}
