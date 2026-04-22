import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { FolderOpen, Plus, RefreshCw, Search, MapPin, Users, CheckCircle2, AlertCircle, Loader2, Trash2, Archive, ArchiveRestore, AlertTriangle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { RetentionBlockedDialog, type RetainedRecordCounts } from "@/components/projects/RetentionBlockedDialog";
import { ApiError } from "@/lib/queryClient";
import { formatLotDescription } from "@shared/lot-label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Project, ArchidocProject, ArchidocSiretIssue } from "@shared/schema";

interface ArchidocProjectEnriched extends ArchidocProject {
  isTracked: boolean;
  architrakProjectId: number | null;
}

interface ArchidocStatus {
  configured: boolean;
  connected: boolean;
  connectionError?: string;
  lastSync: string | null;
  mirroredProjects: number;
  mirroredContractors: number;
  trackedProjects: number;
  siretIssueCount?: number;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

type ProjectsView = "active" | "archived";

export default function Projects() {
  const [view, setView] = useState<ProjectsView>("active");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [siretIssuesOpen, setSiretIssuesOpen] = useState(false);
  const [selectedArchidocId, setSelectedArchidocId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [tvaRate, setTvaRate] = useState("20.00");
  const [feeType, setFeeType] = useState("percentage");
  const [feePercentage, setFeePercentage] = useState("");
  const [conceptionFee, setConceptionFee] = useState("");
  const [planningFee, setPlanningFee] = useState("");
  const [hasMarche, setHasMarche] = useState(false);
  const { toast } = useToast();

  const { data: projects, isLoading } = useQuery<Project[]>({
    queryKey: ["/api/projects", { archived: view === "archived" ? "only" : undefined }],
    queryFn: async () => {
      const url = view === "archived" ? "/api/projects?archived=only" : "/api/projects";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`);
      return res.json();
    },
  });

  const { data: archidocStatus } = useQuery<ArchidocStatus>({
    queryKey: ["/api/archidoc/status"],
  });

  const { data: siretIssues, isLoading: loadingSiretIssues } = useQuery<ArchidocSiretIssue[]>({
    queryKey: ["/api/archidoc/siret-issues"],
    enabled: siretIssuesOpen,
  });

  const { data: archidocProjects, isLoading: loadingArchidoc } = useQuery<ArchidocProjectEnriched[]>({
    queryKey: ["/api/archidoc/projects"],
    enabled: dialogOpen,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/archidoc/sync");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/archidoc/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/archidoc/status"] });
      toast({ title: "Sync complete", description: "ArchiDoc data has been refreshed." });
    },
    onError: (error: Error) => {
      toast({ title: "Sync failed", description: error.message, variant: "destructive" });
    },
  });

  const trackMutation = useMutation({
    mutationFn: async (archidocId: string) => {
      const res = await apiRequest("POST", `/api/archidoc/track/${archidocId}`, {
        tvaRate,
        feeType,
        feePercentage: feePercentage || null,
        conceptionFee: conceptionFee || null,
        planningFee: planningFee || null,
        hasMarche,
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/archidoc/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/archidoc/status"] });
      setDialogOpen(false);
      resetForm();
      toast({
        title: "Project tracked",
        description: `Project created with ${data.contractorsCreated} contractor(s) and ${data.lotsCreated} lot(s).`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  function resetForm() {
    setSelectedArchidocId(null);
    setSearchQuery("");
    setTvaRate("20.00");
    setFeeType("percentage");
    setFeePercentage("");
    setConceptionFee("");
    setPlanningFee("");
    setHasMarche(false);
  }

  const selectedProject = archidocProjects?.find(p => p.archidocId === selectedArchidocId);
  const filteredProjects = archidocProjects?.filter(p => {
    if (p.isTracked) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      p.projectName.toLowerCase().includes(q) ||
      (p.clientName && p.clientName.toLowerCase().includes(q)) ||
      (p.code && p.code.toLowerCase().includes(q)) ||
      (p.address && p.address.toLowerCase().includes(q))
    );
  });

  const clients = selectedProject?.clients as Array<{ name: string; email?: string; phone?: string; address?: string }> | null;
  const customLots = selectedProject?.customLots as Array<{ lotNumber: string; descriptionFr: string; descriptionUk?: string }> | null;

  return (
    <AppLayout>
      <div className="space-y-8">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground" data-testid="text-page-title">
            Projects
          </h1>
          <div className="flex items-center gap-3">
            {archidocStatus && (
              <div className="flex items-center gap-1.5" data-testid="archidoc-status">
                <div className={`w-2 h-2 rounded-full ${archidocStatus.connected ? "bg-emerald-500" : archidocStatus.configured ? "bg-amber-500" : "bg-slate-300"}`} />
                <span className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                  {archidocStatus.connected ? "ArchiDoc Connected" : archidocStatus.configured ? "ArchiDoc Offline" : "ArchiDoc Not Configured"}
                </span>
              </div>
            )}
            {archidocStatus && (archidocStatus.siretIssueCount ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => setSiretIssuesOpen(true)}
                className="flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 hover:bg-amber-100 transition-colors"
                data-testid="button-archidoc-siret-issues"
              >
                <AlertTriangle className="w-3 h-3 text-amber-600" />
                <span className="text-[9px] font-bold uppercase tracking-wider text-amber-800" data-testid="text-archidoc-siret-issue-count">
                  {archidocStatus.siretIssueCount} SIRET {archidocStatus.siretIssueCount === 1 ? "issue" : "issues"}
                </span>
              </button>
            )}
            <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
              <DialogTrigger asChild>
                <Button data-testid="button-new-project">
                  <Plus size={14} />
                  <span className="text-[9px] font-bold uppercase tracking-widest">New Project</span>
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="text-[16px] font-black uppercase tracking-tight">
                    New Project
                  </DialogTitle>
                </DialogHeader>

                {!selectedArchidocId ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                        <Input
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Search ArchiDoc projects..."
                          className="pl-9 text-[12px]"
                          data-testid="input-search-archidoc"
                        />
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => syncMutation.mutate()}
                        disabled={syncMutation.isPending}
                        data-testid="button-sync-archidoc"
                      >
                        <RefreshCw size={12} className={syncMutation.isPending ? "animate-spin" : ""} />
                        <span className="text-[9px] font-bold uppercase tracking-widest">
                          {syncMutation.isPending ? "Syncing..." : "Sync"}
                        </span>
                      </Button>
                    </div>

                    {archidocStatus?.lastSync && (
                      <p className="text-[10px] text-muted-foreground">
                        Last synced: {new Date(archidocStatus.lastSync).toLocaleString()}
                      </p>
                    )}

                    {loadingArchidoc ? (
                      <div className="space-y-2">
                        {Array.from({ length: 3 }).map((_, i) => (
                          <div key={i} className="p-3 rounded-xl border border-border">
                            <Skeleton className="h-4 w-40 mb-1" />
                            <Skeleton className="h-3 w-32" />
                          </div>
                        ))}
                      </div>
                    ) : filteredProjects && filteredProjects.length > 0 ? (
                      <div className="space-y-2 max-h-[400px] overflow-y-auto">
                        {filteredProjects.map((ap) => (
                          <button
                            key={ap.archidocId}
                            onClick={() => setSelectedArchidocId(ap.archidocId)}
                            className="w-full text-left p-3 rounded-xl border border-border hover:border-[#0B2545] hover:bg-slate-50 transition-colors"
                            data-testid={`button-select-project-${ap.archidocId}`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  {ap.code && (
                                    <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{ap.code}</span>
                                  )}
                                  <h4 className="text-[13px] font-semibold text-foreground truncate">{ap.projectName}</h4>
                                </div>
                                {ap.clientName && (
                                  <p className="text-[11px] text-muted-foreground mt-0.5">
                                    <Users className="inline w-3 h-3 mr-1" />
                                    {ap.clientName}
                                  </p>
                                )}
                                {ap.address && (
                                  <p className="text-[10px] text-muted-foreground mt-0.5">
                                    <MapPin className="inline w-3 h-3 mr-1" />
                                    {ap.address}
                                  </p>
                                )}
                              </div>
                              {ap.status && (
                                <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                                  {ap.status}
                                </span>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : !loadingArchidoc && archidocProjects ? (
                      <div className="text-center py-8">
                        {archidocProjects.length === 0 ? (
                          <div className="space-y-2">
                            <AlertCircle className="w-8 h-8 text-muted-foreground mx-auto" />
                            <p className="text-[12px] text-muted-foreground">
                              No ArchiDoc projects found. Click "Sync" to fetch from ArchiDoc.
                            </p>
                          </div>
                        ) : (
                          <p className="text-[12px] text-muted-foreground">
                            {searchQuery ? "No matching projects found." : "All ArchiDoc projects are already tracked."}
                          </p>
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : selectedProject ? (
                  <div className="space-y-5">
                    <button
                      onClick={() => setSelectedArchidocId(null)}
                      className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                      data-testid="button-back-to-list"
                    >
                      &larr; Back to project list
                    </button>

                    <div className="p-4 rounded-xl bg-slate-50 border border-border space-y-2">
                      <div className="flex items-center gap-2">
                        {selectedProject.code && (
                          <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{selectedProject.code}</span>
                        )}
                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      </div>
                      <h3 className="text-[15px] font-bold text-foreground">{selectedProject.projectName}</h3>
                      {clients && clients.length > 0 && (
                        <p className="text-[11px] text-muted-foreground">
                          <Users className="inline w-3 h-3 mr-1" />
                          {clients.map(c => c.name).join(", ")}
                        </p>
                      )}
                      {selectedProject.address && (
                        <p className="text-[11px] text-muted-foreground">
                          <MapPin className="inline w-3 h-3 mr-1" />
                          {selectedProject.address}
                        </p>
                      )}
                      {customLots && customLots.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-border">
                          <TechnicalLabel>Lots ({customLots.length})</TechnicalLabel>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {customLots.map((lot, i) => (
                              <span key={i} className="text-[9px] bg-white border border-border rounded px-1.5 py-0.5">
                                Lot {lot.lotNumber}: {formatLotDescription(lot)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="space-y-4">
                      <TechnicalLabel>ArchiTrak Configuration</TechnicalLabel>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">TVA Rate (%)</Label>
                          <Input
                            value={tvaRate}
                            onChange={(e) => setTvaRate(e.target.value)}
                            type="number"
                            step="0.01"
                            className="mt-1"
                            data-testid="input-tva-rate"
                          />
                        </div>
                        <div>
                          <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Honoraires Type</Label>
                          <Select value={feeType} onValueChange={setFeeType}>
                            <SelectTrigger className="mt-1" data-testid="select-fee-type">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="percentage">Percentage</SelectItem>
                              <SelectItem value="fixed">Fixed</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Honoraires %</Label>
                          <Input
                            value={feePercentage}
                            onChange={(e) => setFeePercentage(e.target.value)}
                            type="number"
                            step="0.01"
                            className="mt-1"
                            data-testid="input-fee-percentage"
                          />
                        </div>
                        <div />
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Conception Fee</Label>
                          <Input
                            value={conceptionFee}
                            onChange={(e) => setConceptionFee(e.target.value)}
                            type="number"
                            step="0.01"
                            className="mt-1"
                            data-testid="input-conception-fee"
                          />
                        </div>
                        <div>
                          <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Planning Fee</Label>
                          <Input
                            value={planningFee}
                            onChange={(e) => setPlanningFee(e.target.value)}
                            type="number"
                            step="0.01"
                            className="mt-1"
                            data-testid="input-planning-fee"
                          />
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Switch
                          checked={hasMarche}
                          onCheckedChange={setHasMarche}
                          data-testid="switch-has-marche"
                        />
                        <Label className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                          Marché de travaux
                        </Label>
                      </div>
                    </div>

                    <Button
                      onClick={() => trackMutation.mutate(selectedArchidocId!)}
                      className="w-full"
                      disabled={trackMutation.isPending}
                      data-testid="button-submit-project"
                    >
                      {trackMutation.isPending ? (
                        <Loader2 size={14} className="animate-spin mr-2" />
                      ) : null}
                      <span className="text-[9px] font-bold uppercase tracking-widest">
                        {trackMutation.isPending ? "Creating..." : "Create Project"}
                      </span>
                    </Button>
                  </div>
                ) : null}
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 flex-wrap">
          <SectionHeader
            icon={view === "archived" ? Archive : FolderOpen}
            title={view === "archived" ? "Archived Projects" : "All Projects"}
            subtitle={view === "archived" ? "Hidden from active list, retained for legal records" : "Manage active projects"}
          />
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-1">
            <button
              onClick={() => setView("active")}
              className={`px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest rounded-md transition-colors ${view === "active" ? "bg-[#0B2545] text-white" : "text-muted-foreground hover:text-foreground"}`}
              data-testid="button-view-active"
            >
              Active
            </button>
            <button
              onClick={() => setView("archived")}
              className={`px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest rounded-md transition-colors ${view === "archived" ? "bg-[#0B2545] text-white" : "text-muted-foreground hover:text-foreground"}`}
              data-testid="button-view-archived"
            >
              Archived
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <LuxuryCard key={i}>
                <Skeleton className="h-4 w-32 mb-2" />
                <Skeleton className="h-3 w-24 mb-4" />
                <Skeleton className="h-6 w-16" />
              </LuxuryCard>
            ))}
          </div>
        ) : projects && projects.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        ) : (
          <LuxuryCard data-testid="card-empty-projects">
            <p className="text-[12px] text-muted-foreground text-center py-8">
              {view === "archived"
                ? "No archived projects."
                : "No projects yet. Click \"New Project\" to import from ArchiDoc."}
            </p>
          </LuxuryCard>
        )}
      </div>

      <Dialog open={siretIssuesOpen} onOpenChange={setSiretIssuesOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto" data-testid="dialog-archidoc-siret-issues">
          <DialogHeader>
            <DialogTitle className="text-[14px] font-black uppercase tracking-tight flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              ArchiDoc SIRET Issues
            </DialogTitle>
          </DialogHeader>
          <p className="text-[11px] text-muted-foreground">
            These contractors arrived from ArchiDoc with a SIRET that isn't 14 digits, so the mirror stored NULL. Fix them in ArchiDoc and they'll clear automatically on the next sync.
          </p>
          {loadingSiretIssues ? (
            <div className="space-y-2 mt-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !siretIssues || siretIssues.length === 0 ? (
            <p className="text-[12px] text-muted-foreground text-center py-6" data-testid="text-no-siret-issues">
              No malformed SIRETs from ArchiDoc right now.
            </p>
          ) : (
            <div className="space-y-2 mt-3">
              {siretIssues.map((issue) => (
                <div
                  key={issue.archidocId}
                  className="rounded-lg border border-border bg-white p-3"
                  data-testid={`row-siret-issue-${issue.archidocId}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className="text-[12px] font-semibold text-foreground truncate"
                          data-testid={`text-siret-issue-name-${issue.archidocId}`}
                        >
                          {issue.name || "(no name)"}
                        </span>
                        <span
                          className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground"
                          data-testid={`text-siret-issue-archidoc-id-${issue.archidocId}`}
                        >
                          ArchiDoc ID: {issue.archidocId}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1">
                        Raw SIRET:{" "}
                        <code
                          className="font-mono text-[11px] bg-amber-50 border border-amber-200 px-1 py-0.5 rounded"
                          data-testid={`text-siret-issue-raw-${issue.archidocId}`}
                        >
                          {issue.rawSiret}
                        </code>
                      </p>
                    </div>
                    <span className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap">
                      Last seen {new Date(issue.lastSeenAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

function ProjectCard({ project }: { project: Project }) {
  interface FinancialSummary {
    totalContractedHt: number;
    totalCertifiedHt: number;
    totalResteARealiser: number;
  }

  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [retained, setRetained] = useState<RetainedRecordCounts | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const isArchived = !!project.archivedAt;

  const { data: summary } = useQuery<FinancialSummary>({
    queryKey: ["/api/projects", project.id, "financial-summary"],
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/projects/${project.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/archidoc/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/archidoc/status"] });
      toast({
        title: "Project deleted",
        description: `${project.name} has been removed.`,
      });
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.status === 409 && error.code === "PROJECT_RETENTION_BLOCKED") {
        const data = error.data as { retained?: RetainedRecordCounts } | null;
        setRetained(data?.retained ?? { invoices: 0, situations: 0, certificats: 0 });
        setConfirmOpen(false);
        setRetentionOpen(true);
        return;
      }
      toast({
        title: "Could not delete project",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async () => {
      const action = isArchived ? "unarchive" : "archive";
      const res = await apiRequest("POST", `/api/projects/${project.id}/${action}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      toast({
        title: isArchived ? "Project restored" : "Project archived",
        description: isArchived
          ? `${project.name} is back in the active list.`
          : `${project.name} is hidden from the active list. Financial records remain on file.`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Action failed", description: error.message, variant: "destructive" });
    },
  });

  const contracted = summary?.totalContractedHt ?? 0;
  const certified = summary?.totalCertifiedHt ?? 0;
  const reste = summary?.totalResteARealiser ?? 0;
  const progress = contracted > 0 ? Math.min((certified / contracted) * 100, 100) : 0;

  return (
    <div className="relative group">
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {isArchived ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              archiveMutation.mutate();
            }}
            disabled={archiveMutation.isPending}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950"
            aria-label={`Restore project ${project.name}`}
            data-testid={`button-unarchive-${project.id}`}
          >
            <ArchiveRestore className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setArchiveOpen(true);
            }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-amber-50 hover:text-amber-600 dark:hover:bg-amber-950"
            aria-label={`Archive project ${project.name}`}
            data-testid={`button-archive-${project.id}`}
          >
            <Archive className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setConfirmOpen(true);
          }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
          aria-label={`Delete project ${project.name}`}
          data-testid={`button-delete-project-${project.id}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <Link href={`/projets/${project.id}`}>
        <LuxuryCard
          className="cursor-pointer hover-elevate transition-all"
          data-testid={`card-project-${project.id}`}
        >
          <div className="flex items-start justify-between gap-2 mb-3">
            <div>
              <TechnicalLabel>{project.code}</TechnicalLabel>
              <h3 className="text-[14px] font-bold text-foreground mt-1" data-testid={`text-project-name-${project.id}`}>
                {project.name}
              </h3>
            </div>
            <div className="flex items-center gap-1.5 pr-16">
              {isArchived && (
                <span className="text-[8px] font-bold uppercase tracking-wider text-slate-600 bg-slate-100 rounded px-1.5 py-0.5" data-testid={`badge-archived-${project.id}`}>
                  Archived
                </span>
              )}
              {project.archidocId && (
                <span className="text-[8px] font-bold uppercase tracking-wider text-emerald-600 bg-emerald-50 rounded px-1.5 py-0.5">
                  ArchiDoc
                </span>
              )}
              <StatusBadge status={project.status} />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground mb-1" data-testid={`text-project-client-${project.id}`}>
            {project.clientName}
          </p>
          {project.siteAddress && (
            <p className="text-[10px] text-muted-foreground mb-4 flex items-center gap-1">
              <MapPin className="w-3 h-3" />
              {project.siteAddress}
            </p>
          )}

          {summary && contracted > 0 && (
            <div className="space-y-2 pt-3 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
              <div className="flex items-center justify-between gap-2">
                <TechnicalLabel>Contracted HT</TechnicalLabel>
                <span className="text-[11px] font-semibold text-foreground" data-testid={`text-contracted-${project.id}`}>
                  {formatCurrency(contracted)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <TechnicalLabel>Certified HT</TechnicalLabel>
                <span className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400" data-testid={`text-certified-${project.id}`}>
                  {formatCurrency(certified)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <TechnicalLabel>Reste à Réaliser</TechnicalLabel>
                <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400" data-testid={`text-reste-${project.id}`}>
                  {formatCurrency(reste)}
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 mt-1">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}
        </LuxuryCard>
      </Link>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid={`dialog-confirm-delete-${project.id}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove <span className="font-semibold text-foreground">{project.name}</span> from ArchiTrak.
              Projects with retained accounting records (invoices, situations, certificats) cannot be deleted under French law — archive them instead to keep the records on file.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-cancel-delete-${project.id}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                deleteMutation.mutate();
              }}
              disabled={deleteMutation.isPending}
              data-testid={`button-confirm-delete-${project.id}`}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RetentionBlockedDialog
        open={retentionOpen}
        onOpenChange={setRetentionOpen}
        projectName={project.name}
        retained={retained}
      />

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent data-testid={`dialog-confirm-archive-${project.id}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this project?</AlertDialogTitle>
            <AlertDialogDescription>
              "{project.name}" will be hidden from your active project list. All financial records
              (invoices, situations, certificats) remain on file and accessible for the 10-year
              legal retention window. You can restore it from the Archived tab at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-cancel-archive-${project.id}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                archiveMutation.mutate();
              }}
              disabled={archiveMutation.isPending}
              data-testid={`button-confirm-archive-${project.id}`}
            >
              {archiveMutation.isPending ? "Archiving..." : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
