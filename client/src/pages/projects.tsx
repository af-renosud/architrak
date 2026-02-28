import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { FolderOpen, Plus } from "lucide-react";
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
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { insertProjectSchema } from "@shared/schema";
import type { Project } from "@shared/schema";
import { z } from "zod";

const projectFormSchema = insertProjectSchema.extend({
  name: z.string().min(1, "Name is required"),
  code: z.string().min(1, "Code is required"),
  clientName: z.string().min(1, "Client name is required"),
});

type ProjectFormValues = z.infer<typeof projectFormSchema>;

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

export default function Projects() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { toast } = useToast();

  const { data: projects, isLoading } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: {
      name: "",
      code: "",
      clientName: "",
      clientAddress: "",
      status: "active",
      tvaRate: "20.00",
      feePercentage: null,
      feeType: "percentage",
      conceptionFee: null,
      planningFee: null,
      hasMarche: false,
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: ProjectFormValues) => {
      const res = await apiRequest("POST", "/api/projects", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      setDialogOpen(false);
      form.reset();
      toast({ title: "Project created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const onSubmit = (data: ProjectFormValues) => {
    createMutation.mutate(data);
  };

  return (
    <AppLayout>
      <div className="space-y-8">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground" data-testid="text-page-title">
            Projects
          </h1>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-new-project">
                <Plus size={14} />
                <span className="text-[9px] font-bold uppercase tracking-widest">New Project</span>
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="text-[16px] font-black uppercase tracking-tight">
                  New Project
                </DialogTitle>
              </DialogHeader>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>Project Name</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input {...field} data-testid="input-project-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="code"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>Code</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="e.g. 1231" data-testid="input-project-code" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="clientName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>Client Name</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input {...field} data-testid="input-client-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="clientAddress"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          <TechnicalLabel>Client Address</TechnicalLabel>
                        </FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value ?? ""} data-testid="input-client-address" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="status"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            <TechnicalLabel>Status</TechnicalLabel>
                          </FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger data-testid="select-status">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="active">Active</SelectItem>
                              <SelectItem value="completed">Completed</SelectItem>
                              <SelectItem value="archived">Archived</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="tvaRate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            <TechnicalLabel>TVA Rate (%)</TechnicalLabel>
                          </FormLabel>
                          <FormControl>
                            <Input {...field} type="number" step="0.01" data-testid="input-tva-rate" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="feeType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            <TechnicalLabel>Honoraires Type</TechnicalLabel>
                          </FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger data-testid="select-fee-type">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="percentage">Percentage</SelectItem>
                              <SelectItem value="fixed">Fixed</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="feePercentage"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            <TechnicalLabel>Honoraires %</TechnicalLabel>
                          </FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              value={field.value ?? ""}
                              onChange={(e) => field.onChange(e.target.value || null)}
                              type="number"
                              step="0.01"
                              data-testid="input-fee-percentage"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="conceptionFee"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            <TechnicalLabel>Conception Fee</TechnicalLabel>
                          </FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              value={field.value ?? ""}
                              onChange={(e) => field.onChange(e.target.value || null)}
                              type="number"
                              step="0.01"
                              data-testid="input-conception-fee"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="planningFee"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>
                            <TechnicalLabel>Planning Fee</TechnicalLabel>
                          </FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              value={field.value ?? ""}
                              onChange={(e) => field.onChange(e.target.value || null)}
                              type="number"
                              step="0.01"
                              data-testid="input-planning-fee"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <FormField
                    control={form.control}
                    name="hasMarche"
                    render={({ field }) => (
                      <FormItem className="flex items-center gap-3">
                        <FormControl>
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            data-testid="switch-has-marche"
                          />
                        </FormControl>
                        <FormLabel className="!mt-0">
                          <TechnicalLabel>Marché de travaux</TechnicalLabel>
                        </FormLabel>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" className="w-full" disabled={createMutation.isPending} data-testid="button-submit-project">
                    <span className="text-[9px] font-bold uppercase tracking-widest">
                      {createMutation.isPending ? "Creating..." : "Create Project"}
                    </span>
                  </Button>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>

        <SectionHeader
          icon={FolderOpen}
          title="All Projects"
          subtitle="Manage active projects"
        />

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
              No projects yet. Create your first project to get started.
            </p>
          </LuxuryCard>
        )}
      </div>
    </AppLayout>
  );
}

function ProjectCard({ project }: { project: Project }) {
  interface FinancialSummary {
    totalContractedHt: number;
    totalCertifiedHt: number;
    totalResteARealiser: number;
  }

  const { data: summary } = useQuery<FinancialSummary>({
    queryKey: ["/api/projects", project.id, "financial-summary"],
  });

  const contracted = summary?.totalContractedHt ?? 0;
  const certified = summary?.totalCertifiedHt ?? 0;
  const reste = summary?.totalResteARealiser ?? 0;
  const progress = contracted > 0 ? Math.min((certified / contracted) * 100, 100) : 0;

  return (
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
          <StatusBadge status={project.status} />
        </div>
        <p className="text-[11px] text-muted-foreground mb-4" data-testid={`text-project-client-${project.id}`}>
          {project.clientName}
        </p>

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
  );
}
