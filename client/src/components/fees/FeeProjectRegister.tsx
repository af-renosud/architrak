import { useQuery } from "@tanstack/react-query";
import type { Fee, FeeEntry, Project } from "@shared/schema";
import { useFeeVisibility } from "@/hooks/use-fee-visibility";
import { feeGroupMatchesVisibility, registerTotals, type RegisterContractTotals, type VisibilityFilter } from "@/lib/fee-register";
import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

function ProjectRow({ project, selected, onSelect, phase, visibility }: { project: Project; selected: boolean; onSelect: () => void; phase: string; visibility: VisibilityFilter }) {
  const fees = useQuery<Fee[]>({ queryKey: ["/api/projects", String(project.id), "fees"] });
  const entries = useQuery<FeeEntry[]>({ queryKey: ["/api/projects", String(project.id), "fee-entries"] });
  const contract = useQuery<{ designContract?: RegisterContractTotals | null }>({ queryKey: ["/api/projects", String(project.id), "fees", "by-phase"] });
  const state = useFeeVisibility(String(project.id));
  if (fees.isLoading || entries.isLoading || state.isLoading || contract.isLoading) return <Skeleton className="h-14 m-2" />;
  if (fees.error || entries.error || state.error || contract.error) return <div className="p-4 text-sm" role="alert">{project.code} — Register unavailable: {(fees.error || entries.error || state.error || contract.error)?.message} <Button variant="outline" size="sm" onClick={() => { void fees.refetch(); void entries.refetch(); void state.refetch(); void contract.refetch(); }}>Retry</Button></div>;
  const count = (fees.data ?? []).filter(fee => (phase === "all" || (fee.phase ?? "unassigned") === phase) && feeGroupMatchesVisibility(
    state.data?.records.find(record => record.kind === "fee" && record.id === fee.id),
    (entries.data ?? []).filter(entry => entry.feeId === fee.id).map(entry => state.data?.records.find(record => record.kind === "entry" && record.id === entry.id)),
    visibility
  )).length;
  const totals = registerTotals(fees.data ?? [], contract.data?.designContract);
  return <button type="button" className="fee-register-row" aria-current={selected} onClick={onSelect}>
    <span><strong className="text-sm">{project.code}</strong><span className="ml-3 text-sm text-muted-foreground">{project.name}</span></span>
    <span className="text-xs text-muted-foreground">{count} matching fee group{count === 1 ? "" : "s"} · Full project <Amount value={totals.totalFeeEarnedTtc} denomination="TTC" /> · Remaining to invoice <Amount value={totals.totalRemainingTtc} denomination="TTC" /> · {selected ? "Selected project" : "Open register"}</span>
  </button>;
}
export function FeeProjectRegister({ projects, selectedProjectId, onSelect, phase, visibility }: { projects: Project[]; selectedProjectId: string; onSelect: (id: string) => void; phase: string; visibility: VisibilityFilter }) {
  const ordered = [...projects].sort((a, b) => Number(String(b.id) === selectedProjectId) - Number(String(a.id) === selectedProjectId));
  return <section className="rounded-lg border overflow-hidden" aria-label="Project fee register">
    <div className="px-4 py-3 bg-muted/30 text-xs font-semibold uppercase tracking-wider">Project register · amounts include all phases & archives, not unpaid balances</div>
    {!ordered.length && <p className="p-5 text-sm text-muted-foreground">No projects available.</p>}
    {ordered.map(project => <ProjectRow key={project.id} project={project} selected={String(project.id) === selectedProjectId} onSelect={() => onSelect(String(project.id))} phase={phase} visibility={visibility} />)}
  </section>;
}
