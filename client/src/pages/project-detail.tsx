import { useState, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { FolderOpen, ArrowLeft, MapPin, User, FileText, Layers, ScrollText, Award, Coins, BarChart3, Plus, Eye, EyeOff, ChevronRight, Pencil, Upload, Download, ExternalLink, MessageSquare, Send, Clock, RefreshCw, FileCheck, AlertTriangle, Settings, Loader2, FolderDown, Archive, ArchiveRestore } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Link, useParams } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { insertCertificatSchema, insertFeeSchema, insertFeeEntrySchema, insertLotSchema, insertMarcheSchema } from "@shared/schema";
import type { Project, Devis, Lot, Marche, Certificat, Fee, FeeEntry, Contractor, Invoice, ProjectDocument, ProjectCommunication, PaymentReminder } from "@shared/schema";
import { DevisTab } from "@/components/devis/DevisTab";
import { FacturesTab } from "@/components/factures/FacturesTab";
import { Receipt } from "lucide-react";
import { z } from "zod";

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

interface FinancialSummary {
  projectId: number;
  projectName: string;
  projectCode: string;
  totalContractedHt: number;
  totalContractedTtc: number;
  totalCertifiedHt: number;
  totalCertifiedTtc: number;
  totalResteARealiser: number;
  totalResteARealiserTtc: number;
  totalOriginalHt: number;
  totalOriginalTtc: number;
  totalPv: number;
  totalMv: number;
  devis: DevisSummary[];
}

interface DevisSummary {
  devisId: number;
  devisCode: string;
  descriptionFr: string;
  descriptionUk: string | null;
  status: string;
  contractorId: number;
  invoicingMode: string;
  originalHt: number;
  originalTtc: number;
  pvTotal: number;
  mvTotal: number;
  adjustedHt: number;
  adjustedTtc: number;
  certifiedHt: number;
  certifiedTtc: number;
  resteARealiser: number;
  resteARealiserTtc: number;
  invoiceCount: number;
  avenantCount: number;
}

function CommissionInput({ projectId, initialValue }: { projectId: number; initialValue: string }) {
  const { toast } = useToast();
  const [value, setValue] = useState(initialValue);
  const [savedValue, setSavedValue] = useState(initialValue);

  useEffect(() => {
    setValue(initialValue);
    setSavedValue(initialValue);
  }, [initialValue]);

  const saveMutation = useMutation({
    mutationFn: async (newPct: string) => {
      await apiRequest("PATCH", `/api/projects/${projectId}`, { feePercentage: newPct });
    },
    onSuccess: (_data, newPct) => {
      setSavedValue(newPct);
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId)] });
      toast({ title: "Commission rate saved" });
    },
    onError: (error: Error) => {
      setValue(savedValue);
      toast({ title: "Failed to save commission rate", description: error.message, variant: "destructive" });
    },
  });
  return (
    <div className="flex items-center gap-1.5 mt-1">
      <Input
        type="number"
        step="0.1"
        min="0"
        max="100"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (value !== savedValue) saveMutation.mutate(value);
        }}
        className="w-20 h-8 text-[13px] font-semibold border-[#c1a27b]/40 focus:border-[#c1a27b]"
        data-testid="input-commission-pct"
      />
      <span className="text-[12px] text-muted-foreground">%</span>
      {saveMutation.isPending && <span className="text-[10px] text-muted-foreground">Saving...</span>}
    </div>
  );
}

const certFormSchema = insertCertificatSchema.extend({
  certificateRef: z.string().min(1, "Reference is required"),
  totalWorksHt: z.string().min(1, "Required"),
  netToPayHt: z.string().min(1, "Required"),
  tvaAmount: z.string().min(1, "Required"),
  netToPayTtc: z.string().min(1, "Required"),
});
type CertFormValues = z.infer<typeof certFormSchema>;

const feeFormSchema = insertFeeSchema.extend({
  feeAmountHt: z.string().min(1, "Required"),
  remainingAmount: z.string().min(1, "Required"),
});
type FeeFormValues = z.infer<typeof feeFormSchema>;

const entryFormSchema = insertFeeEntrySchema.extend({
  baseHt: z.string().min(1, "Required"),
  feeRate: z.string().min(1, "Required"),
  feeAmount: z.string().min(1, "Required"),
});
type EntryFormValues = z.infer<typeof entryFormSchema>;

export default function ProjectDetail() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const { toast } = useToast();

  const [certDialogOpen, setCertDialogOpen] = useState(false);
  const [viewingCert, setViewingCert] = useState<Certificat | null>(null);
  const [feeDialogOpen, setFeeDialogOpen] = useState(false);
  const [entryDialogOpen, setEntryDialogOpen] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<number | null>(null);
  const [lotDialogOpen, setLotDialogOpen] = useState(false);
  const [editingLot, setEditingLot] = useState<Lot | null>(null);
  const [marcheDialogOpen, setMarcheDialogOpen] = useState(false);
  const [markInvoicedEntryId, setMarkInvoicedEntryId] = useState<number | null>(null);
  const [markInvoicedRef, setMarkInvoicedRef] = useState("");
  const [showVoidSummary, setShowVoidSummary] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewingCertId, setPreviewingCertId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);

  const { data: project, isLoading } = useQuery<Project>({
    queryKey: ["/api/projects", projectId],
  });

  const { data: devisList } = useQuery<Devis[]>({
    queryKey: ["/api/projects", projectId, "devis"],
    enabled: !!project,
  });

  const { data: lotsList } = useQuery<Lot[]>({
    queryKey: ["/api/projects", projectId, "lots"],
    enabled: !!project,
  });

  const { data: marchesList } = useQuery<Marche[]>({
    queryKey: ["/api/projects", projectId, "marches"],
    enabled: !!project && !!project.hasMarche,
  });

  const { data: certificatsList } = useQuery<Certificat[]>({
    queryKey: ["/api/projects", projectId, "certificats"],
    enabled: !!project,
  });

  const { data: feesList } = useQuery<Fee[]>({
    queryKey: ["/api/projects", projectId, "fees"],
    enabled: !!project,
  });

  const { data: feeEntries } = useQuery<FeeEntry[]>({
    queryKey: ["/api/projects", projectId, "fee-entries"],
    enabled: !!project,
  });

  const { data: contractors } = useQuery<Contractor[]>({
    queryKey: ["/api/contractors"],
    enabled: !!project,
  });

  const { data: projectInvoices } = useQuery<Invoice[]>({
    queryKey: ["/api/projects", projectId, "invoices"],
    enabled: !!project,
  });

  const { data: financialSummary } = useQuery<FinancialSummary>({
    queryKey: ["/api/projects", projectId, "financial-summary"],
    enabled: !!project,
  });

  const { data: projectDocuments } = useQuery<ProjectDocument[]>({
    queryKey: ["/api/projects", projectId, "documents"],
    enabled: !!project,
  });

  const { data: projectComms } = useQuery<ProjectCommunication[]>({
    queryKey: ["/api/projects", projectId, "communications"],
    enabled: !!project,
  });

  const { data: reminders } = useQuery<PaymentReminder[]>({
    queryKey: ["/api/projects", projectId, "reminders"],
    enabled: !!project,
  });

  const certForm = useForm<CertFormValues>({
    resolver: zodResolver(certFormSchema),
    defaultValues: {
      projectId: 0, contractorId: 0, certificateRef: "", dateIssued: null,
      totalWorksHt: "0.00", pvMvAdjustment: "0.00", previousPayments: "0.00",
      retenueGarantie: "0.00", netToPayHt: "0.00", tvaAmount: "0.00",
      netToPayTtc: "0.00", status: "draft", notes: null,
    },
  });

  const feeForm = useForm<FeeFormValues>({
    resolver: zodResolver(feeFormSchema),
    defaultValues: {
      projectId: 0, feeType: "works_percentage", baseAmountHt: "0.00",
      feeRate: null, feeAmountHt: "0.00",
      invoicedAmount: "0.00", remainingAmount: "0.00", pennylaneRef: null, status: "pending",
    },
  });

  const entryForm = useForm<EntryFormValues>({
    resolver: zodResolver(entryFormSchema),
    defaultValues: {
      feeId: 0, invoiceId: null, devisId: null, baseHt: "0.00",
      feeRate: "0.00", feeAmount: "0.00", pennylaneInvoiceRef: null,
      dateInvoiced: null, status: "pending",
    },
  });

  const lotFormSchema = insertLotSchema.extend({
    lotNumber: z.string().min(1, "Required"),
    descriptionFr: z.string().min(1, "Description is required"),
  });
  const lotForm = useForm<z.infer<typeof lotFormSchema>>({
    resolver: zodResolver(lotFormSchema),
    defaultValues: { projectId: parseInt(projectId!), lotNumber: "", descriptionFr: "", descriptionUk: null },
  });

  const marcheFormSchema = insertMarcheSchema.extend({
    totalHt: z.string().min(1, "Required"),
    totalTtc: z.string().min(1, "Required"),
  });
  const marcheForm = useForm<z.infer<typeof marcheFormSchema>>({
    resolver: zodResolver(marcheFormSchema),
    defaultValues: {
      projectId: parseInt(projectId!), contractorId: 0, marcheNumber: null,
      priceType: "forfaitaire", totalHt: "0.00", totalTtc: "0.00",
      retenueGarantiePercent: "5.00", paymentSchedule: null, signedDate: null, status: "draft",
    },
  });

  const createLotMutation = useMutation({
    mutationFn: async (data: z.infer<typeof lotFormSchema>) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/lots`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "lots"] });
      setLotDialogOpen(false);
      lotForm.reset();
      toast({ title: "Lot created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateLotMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: z.infer<typeof lotFormSchema> }) => {
      const res = await apiRequest("PATCH", `/api/lots/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "lots"] });
      setEditingLot(null);
      setLotDialogOpen(false);
      lotForm.reset();
      toast({ title: "Lot updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const createMarcheMutation = useMutation({
    mutationFn: async (data: z.infer<typeof marcheFormSchema>) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/marches`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "marches"] });
      setMarcheDialogOpen(false);
      marcheForm.reset();
      toast({ title: "Marché created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const createCertMutation = useMutation({
    mutationFn: async (data: CertFormValues) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/certificats`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "certificats"] });
      setCertDialogOpen(false);
      certForm.reset();
      toast({ title: "Certificat created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateCertStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/certificats/${id}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "certificats"] });
      toast({ title: "Status updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const createFeeMutation = useMutation({
    mutationFn: async (data: FeeFormValues) => {
      const res = await apiRequest("POST", "/api/fees", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "fees"] });
      setFeeDialogOpen(false);
      feeForm.reset();
      toast({ title: "Fee created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const createEntryMutation = useMutation({
    mutationFn: async (data: EntryFormValues) => {
      const res = await apiRequest("POST", `/api/fees/${data.feeId}/entries`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "fee-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "fees"] });
      setEntryDialogOpen(false);
      entryForm.reset();
      toast({ title: "Entry created" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateEntryMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<EntryFormValues> }) => {
      const res = await apiRequest("PATCH", `/api/fee-entries/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "fee-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "fees"] });
      setEntryDialogOpen(false);
      setEditingEntryId(null);
      entryForm.reset();
      toast({ title: "Entry updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const markInvoicedMutation = useMutation({
    mutationFn: async ({ entryId, pennylaneInvoiceRef }: { entryId: number; pennylaneInvoiceRef?: string }) => {
      const res = await apiRequest("POST", `/api/fee-entries/${entryId}/mark-invoiced`, {
        pennylaneInvoiceRef: pennylaneInvoiceRef || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "fee-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "fees"] });
      setMarkInvoicedEntryId(null);
      setMarkInvoicedRef("");
      toast({ title: "Commission marked as invoiced" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const uploadDocMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/projects/${projectId}/documents/upload`, { method: "POST", body: formData });
      if (!res.ok) throw new Error("Upload failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "documents"] });
      toast({ title: "Document uploaded" });
    },
    onError: (error: Error) => {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    },
  });

  const sendCertMutation = useMutation({
    mutationFn: async (certId: number) => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/certificats/${certId}/send`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "communications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "certificats"] });
      toast({ title: "Certificat queued for sending" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const sendCommMutation = useMutation({
    mutationFn: async (commId: number) => {
      const res = await apiRequest("POST", `/api/communications/${commId}/send`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "communications"] });
      toast({ title: "Communication sent" });
    },
    onError: (error: Error) => {
      toast({ title: "Send failed", description: error.message, variant: "destructive" });
    },
  });

  const cancelReminderMutation = useMutation({
    mutationFn: async (reminderId: number) => {
      const res = await apiRequest("POST", `/api/reminders/${reminderId}/cancel`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "reminders"] });
      toast({ title: "Reminder cancelled" });
    },
  });

  const unarchiveProjectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/unarchive`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      toast({ title: "Project restored", description: "Project is back in the active list." });
    },
    onError: (error: Error) => {
      toast({ title: "Restore failed", description: error.message, variant: "destructive" });
    },
  });

  const refreshProjectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/refresh`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId] });
      queryClient.invalidateQueries({ queryKey: ["/api/contractors"] });
      toast({ title: "Project refreshed from ArchiDoc" });
    },
    onError: (error: Error) => {
      toast({ title: "Refresh failed", description: error.message, variant: "destructive" });
    },
  });

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await window.fetch(`/api/projects/${projectId}/export`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Export failed" }));
        throw new Error(err.message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project?.code ?? "Project"}_Export.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err: unknown) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  const handleFileUpload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) uploadDocMutation.mutate(file);
    };
    input.click();
  };

  const getContractorName = (id: number) => contractors?.find((c) => c.id === id)?.name ?? `#${id}`;

  const recalcCert = () => {
    const totalWorks = parseFloat(certForm.watch("totalWorksHt") || "0");
    const pvMv = parseFloat(certForm.watch("pvMvAdjustment") || "0");
    const previous = parseFloat(certForm.watch("previousPayments") || "0");
    const retenue = parseFloat(certForm.watch("retenueGarantie") || "0");
    const netHt = totalWorks + pvMv - previous - retenue;
    const tva = netHt * 0.2;
    certForm.setValue("netToPayHt", netHt.toFixed(2));
    certForm.setValue("tvaAmount", tva.toFixed(2));
    certForm.setValue("netToPayTtc", (netHt + tva).toFixed(2));
  };

  const recalcFee = () => {
    const base = parseFloat(feeForm.watch("baseAmountHt") || "0");
    const rate = parseFloat(feeForm.watch("feeRate") || "0");
    const feeType = feeForm.watch("feeType");
    let feeHt = feeType === "works_percentage" ? base * (rate / 100) : parseFloat(feeForm.watch("feeAmountHt") || "0");
    feeForm.setValue("feeAmountHt", feeHt.toFixed(2));
    feeForm.setValue("remainingAmount", (feeHt - parseFloat(feeForm.watch("invoicedAmount") || "0")).toFixed(2));
  };

  const recalcEntry = () => {
    const base = parseFloat(entryForm.watch("baseHt") || "0");
    const rate = parseFloat(entryForm.watch("feeRate") || "0");
    entryForm.setValue("feeAmount", (base * rate / 100).toFixed(2));
  };

  const previewCertPdf = async (certId: number) => {
    setPreviewingCertId(certId);
    try {
      const res = await fetch(`/api/certificats/${certId}/preview`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Preview failed" }));
        throw new Error(err.message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err: unknown) {
      toast({ title: "Preview failed", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setPreviewingCertId(null);
    }
  };

  const openCreateCert = () => {
    const totalInvHt = (projectInvoices ?? []).reduce((s, i) => s + parseFloat(i.amountHt), 0);
    certForm.reset({
      projectId: parseInt(projectId!), contractorId: 0, certificateRef: "",
      dateIssued: null, totalWorksHt: totalInvHt.toFixed(2), pvMvAdjustment: "0.00",
      previousPayments: "0.00", retenueGarantie: "0.00",
      netToPayHt: totalInvHt.toFixed(2), tvaAmount: (totalInvHt * 0.2).toFixed(2),
      netToPayTtc: (totalInvHt * 1.2).toFixed(2), status: "draft", notes: null,
    });
    setCertDialogOpen(true);
  };

  const openCreateFee = () => {
    feeForm.reset({
      projectId: parseInt(projectId!), feeType: "works_percentage",
      baseAmountHt: "0.00", feeRate: null, feeAmountHt: "0.00",
      invoicedAmount: "0.00", remainingAmount: "0.00",
      pennylaneRef: null, status: "pending",
    });
    setFeeDialogOpen(true);
  };

  const openCreateEntry = (feeId: number) => {
    const fee = feesList?.find((f) => f.id === feeId);
    setEditingEntryId(null);
    entryForm.reset({
      feeId, invoiceId: null, devisId: null, baseHt: "0.00",
      feeRate: fee?.feeRate ?? "0.00", feeAmount: "0.00",
      pennylaneInvoiceRef: null, dateInvoiced: null, status: "pending",
    });
    setEntryDialogOpen(true);
  };

  const openEditEntry = (entry: FeeEntry) => {
    setEditingEntryId(entry.id);
    entryForm.reset({
      feeId: entry.feeId, invoiceId: entry.invoiceId, devisId: entry.devisId,
      baseHt: entry.baseHt, feeRate: entry.feeRate, feeAmount: entry.feeAmount,
      pennylaneInvoiceRef: entry.pennylaneInvoiceRef, dateInvoiced: entry.dateInvoiced,
      status: entry.status,
    });
    setEntryDialogOpen(true);
  };

  const isArchived = !!project?.archivedAt;

  const getNextCertStatus = (s: string) => ({ draft: "ready", ready: "sent", sent: "paid" }[s] ?? null);
  const getNextCertLabel = (s: string) => ({ draft: "Mark Ready", ready: "Mark Sent", sent: "Mark Paid" }[s] ?? null);

  if (isLoading) {
    return (
      <AppLayout>
        <div className="space-y-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-32 w-full rounded-[2rem]" />
        </div>
      </AppLayout>
    );
  }

  if (!project) {
    return (
      <AppLayout>
        <div className="space-y-6">
          <p className="text-muted-foreground">Project not found.</p>
          <Link href="/projets">
            <Button variant="outline" data-testid="button-back-projects">
              <ArrowLeft size={14} />
              <span className="text-[9px] font-bold uppercase tracking-widest">Back to Projects</span>
            </Button>
          </Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-8">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/projets">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft size={16} />
            </Button>
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground" data-testid="text-project-name">
                {project.name}
              </h1>
              <StatusBadge status={project.status} />
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <TechnicalLabel data-testid="text-project-code">{project.code}</TechnicalLabel>
              <span className="text-[11px] text-muted-foreground">—</span>
              <div className="flex items-center gap-1">
                <User size={10} className="text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground">{project.clientName}</span>
              </div>
              {project.clientAddress && (
                <>
                  <span className="text-[11px] text-muted-foreground">—</span>
                  <div className="flex items-center gap-1">
                    <MapPin size={10} className="text-muted-foreground" />
                    <span className="text-[11px] text-muted-foreground">{project.clientAddress}</span>
                  </div>
                </>
              )}
              {(project as any).siteAddress && (project as any).siteAddress !== project.clientAddress && (
                <>
                  <span className="text-[11px] text-muted-foreground">—</span>
                  <div className="flex items-center gap-1">
                    <MapPin size={10} className="text-emerald-600" />
                    <span className="text-[11px] text-emerald-600">Site: {(project as any).siteAddress}</span>
                  </div>
                </>
              )}
            </div>
            {(project as any).lastSyncedAt && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[9px] text-muted-foreground">
                  Last synced: {new Date((project as any).lastSyncedAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-2"
                  onClick={() => refreshProjectMutation.mutate()}
                  disabled={refreshProjectMutation.isPending || isArchived}
                  data-testid="button-refresh-project"
                >
                  <RefreshCw size={10} className={refreshProjectMutation.isPending ? "animate-spin" : ""} />
                  <span className="text-[8px] font-bold uppercase tracking-widest">Refresh</span>
                </Button>
              </div>
            )}
          </div>
        </div>

        {isArchived && (
          <LuxuryCard
            className="border-amber-300 dark:border-amber-700 bg-amber-50/70 dark:bg-amber-950/30"
            data-testid="banner-archived"
          >
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-start gap-3 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center flex-shrink-0">
                  <Archive size={16} className="text-amber-700 dark:text-amber-300" />
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-bold text-amber-900 dark:text-amber-100" data-testid="text-archived-title">
                    This project is archived
                  </p>
                  <p className="text-[11px] text-amber-800/80 dark:text-amber-200/80 mt-0.5">
                    Hidden from the active list. Financial records remain on file. New uploads, devis edits and other write actions are disabled — restore the project to make changes.
                    {project.archivedAt && (
                      <>
                        {" "}<span className="font-semibold">Archived on {new Date(project.archivedAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" })}.</span>
                      </>
                    )}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="border-amber-400 text-amber-900 hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-900/40"
                onClick={() => unarchiveProjectMutation.mutate()}
                disabled={unarchiveProjectMutation.isPending}
                data-testid="button-restore-project"
              >
                <ArchiveRestore size={12} />
                <span className="text-[9px] font-bold uppercase tracking-widest">
                  {unarchiveProjectMutation.isPending ? "Restoring..." : "Restore Project"}
                </span>
              </Button>
            </div>
          </LuxuryCard>
        )}

        <div className="flex items-center justify-end gap-2 mb-1 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={exporting}
            data-testid="button-export-project"
          >
            {exporting ? <Loader2 size={12} className="animate-spin" /> : <FolderDown size={12} />}
            {exporting ? "Exporting..." : "Export Project Folder"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] px-3 gap-1.5"
            onClick={() => setSettingsOpen(true)}
            data-testid="button-project-settings"
          >
            <Settings size={12} />
            Honoraires: {project.feeType === "percentage" ? `${project.feePercentage ?? 0}%` : "Fixed"} · Marché: {project.hasMarche ? "Yes" : "No"}
          </Button>
        </div>

        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-[16px] font-black uppercase tracking-tight">Project Settings</DialogTitle>
              <DialogDescription className="text-[11px] text-muted-foreground">
                Commission and contract settings for this project
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div>
                <TechnicalLabel>Honoraires Type</TechnicalLabel>
                <p className="text-[13px] font-semibold text-foreground mt-1" data-testid="text-fee-type">
                  {project.feeType === "percentage" ? "Percentage" : "Fixed"}
                </p>
              </div>
              <div>
                <TechnicalLabel>Honoraires %</TechnicalLabel>
                {isArchived ? (
                  <p className="text-[13px] font-semibold text-muted-foreground mt-1" data-testid="text-fee-pct-readonly">
                    {project.feePercentage ?? "0"}%
                  </p>
                ) : (
                  <CommissionInput projectId={parseInt(projectId!)} initialValue={project.feePercentage ?? "0"} />
                )}
              </div>
              <div>
                <TechnicalLabel>Marché</TechnicalLabel>
                <p className="text-[13px] font-semibold text-foreground mt-1" data-testid="text-has-marche">
                  {project.hasMarche ? "Yes" : "No"}
                </p>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <Tabs defaultValue="resume" data-testid="tabs-project-detail">
          <TabsList className="flex-wrap">
            <TabsTrigger value="resume" data-testid="tab-resume">
              <BarChart3 size={12} className="mr-1" />
              Financial Summary
            </TabsTrigger>
            <TabsTrigger value="devis" data-testid="tab-devis">
              <FileText size={12} className="mr-1" />
              Devis
            </TabsTrigger>
            <TabsTrigger value="factures" data-testid="tab-factures">
              <Receipt size={12} className="mr-1" />
              Factures
            </TabsTrigger>
            <TabsTrigger value="lots" data-testid="tab-lots">
              <Layers size={12} className="mr-1" />
              Lots
            </TabsTrigger>
            {project.hasMarche && (
              <TabsTrigger value="marche" data-testid="tab-marche">
                <ScrollText size={12} className="mr-1" />
                Marché
              </TabsTrigger>
            )}
            <TabsTrigger value="certificats" data-testid="tab-certificats">
              <Award size={12} className="mr-1" />
              Certificats
            </TabsTrigger>
            <TabsTrigger value="honoraires" data-testid="tab-honoraires">
              <Coins size={12} className="mr-1" />
              Honoraires
            </TabsTrigger>
            <TabsTrigger value="documents" data-testid="tab-documents">
              <FileText size={12} className="mr-1" />
              Documents {projectDocuments && projectDocuments.length > 0 ? `(${projectDocuments.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="communications" data-testid="tab-communications">
              <MessageSquare size={12} className="mr-1" />
              Communications {projectComms && projectComms.length > 0 ? `(${projectComms.length})` : ""}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="resume">
            {financialSummary ? (
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <LuxuryCard data-testid="card-total-contracted">
                    <TechnicalLabel>Total Contracted</TechnicalLabel>
                    <p className="text-[20px] font-light text-foreground mt-2" data-testid="text-total-contracted">
                      {formatCurrency(financialSummary.totalContractedTtc)} <span className="text-[11px] text-muted-foreground">TTC</span>
                    </p>
                    <p className="text-[12px] text-muted-foreground">{formatCurrency(financialSummary.totalContractedHt)} HT</p>
                  </LuxuryCard>
                  <LuxuryCard data-testid="card-total-certified">
                    <TechnicalLabel>Total Certified</TechnicalLabel>
                    <p className="text-[20px] font-light text-emerald-600 dark:text-emerald-400 mt-2" data-testid="text-total-certified">
                      {formatCurrency(financialSummary.totalCertifiedTtc)} <span className="text-[11px] text-muted-foreground">TTC</span>
                    </p>
                    <p className="text-[12px] text-muted-foreground">{formatCurrency(financialSummary.totalCertifiedHt)} HT</p>
                  </LuxuryCard>
                  <LuxuryCard data-testid="card-total-reste">
                    <TechnicalLabel>Reste à Réaliser</TechnicalLabel>
                    <p className="text-[20px] font-light text-amber-600 dark:text-amber-400 mt-2" data-testid="text-total-reste">
                      {formatCurrency(financialSummary.totalResteARealiserTtc)} <span className="text-[11px] text-muted-foreground">TTC</span>
                    </p>
                    <p className="text-[12px] text-muted-foreground">{formatCurrency(financialSummary.totalResteARealiser)} HT</p>
                  </LuxuryCard>
                </div>

                {financialSummary.devis.length > 0 ? (
                  <LuxuryCard data-testid="card-devis-breakdown">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground">
                        Breakdown by Devis
                      </h3>
                      {financialSummary.devis.filter(ds => ds.status === "void").length > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-[10px] px-3 gap-1.5"
                          onClick={() => setShowVoidSummary(!showVoidSummary)}
                          data-testid="button-toggle-void-summary"
                        >
                          {showVoidSummary ? <EyeOff size={12} /> : <Eye size={12} />}
                          {showVoidSummary ? "Hide" : "Show"} Void [{financialSummary.devis.filter(ds => ds.status === "void").length}]
                        </Button>
                      )}
                    </div>
                    <div className="space-y-4">
                      {financialSummary.devis.filter(ds => showVoidSummary || ds.status !== "void").map((ds) => {
                        const progress = ds.adjustedHt > 0
                          ? Math.min((ds.certifiedHt / ds.adjustedHt) * 100, 100)
                          : 0;
                        return (
                          <div
                            key={ds.devisId}
                            className="p-4 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] space-y-3"
                            data-testid={`card-devis-summary-${ds.devisId}`}
                          >
                            <div className="flex items-start justify-between gap-2 flex-wrap">
                              <div>
                                <TechnicalLabel>{ds.devisCode}</TechnicalLabel>
                                <p className="text-[12px] text-foreground mt-0.5">{ds.descriptionFr}</p>
                              </div>
                              <StatusBadge status={ds.status} />
                            </div>
                            <div className="grid grid-cols-3 gap-4">
                              <div>
                                <TechnicalLabel>Contracted</TechnicalLabel>
                                <p className="text-[12px] font-semibold text-foreground mt-0.5">
                                  {formatCurrency(ds.adjustedHt)}
                                </p>
                              </div>
                              <div>
                                <TechnicalLabel>Certified</TechnicalLabel>
                                <p className="text-[12px] font-semibold text-emerald-600 dark:text-emerald-400 mt-0.5">
                                  {formatCurrency(ds.certifiedHt)}
                                </p>
                              </div>
                              <div>
                                <TechnicalLabel>Remaining</TechnicalLabel>
                                <p className="text-[12px] font-semibold text-amber-600 dark:text-amber-400 mt-0.5">
                                  {formatCurrency(ds.resteARealiser)}
                                </p>
                              </div>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800">
                              <div
                                className="h-full rounded-full bg-emerald-500 transition-all"
                                style={{ width: `${progress}%` }}
                              />
                            </div>
                            <div className="flex items-center gap-4 flex-wrap">
                              <span className="text-[10px] text-muted-foreground">
                                {ds.invoiceCount} invoice{ds.invoiceCount !== 1 ? "s" : ""}
                              </span>
                              <span className="text-[10px] text-muted-foreground">
                                {ds.avenantCount} avenant{ds.avenantCount !== 1 ? "s" : ""} 
                              </span>
                              {ds.pvTotal > 0 && (
                                <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
                                  PV: +{formatCurrency(ds.pvTotal)}
                                </span>
                              )}
                              {ds.mvTotal > 0 && (
                                <span className="text-[10px] text-red-600 dark:text-red-400">
                                  MV: -{formatCurrency(ds.mvTotal)}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </LuxuryCard>
                ) : (
                  <LuxuryCard data-testid="card-no-devis-summary">
                    <p className="text-[12px] text-muted-foreground text-center py-8">
                      No Devis for this project.
                    </p>
                  </LuxuryCard>
                )}
              </div>
            ) : (
              <LuxuryCard>
                <Skeleton className="h-20 w-full" />
              </LuxuryCard>
            )}
          </TabsContent>

          <TabsContent value="devis">
            <DevisTab
              projectId={projectId!}
              contractors={contractors ?? []}
              lots={lotsList ?? []}
              isArchived={isArchived}
            />
          </TabsContent>

          <TabsContent value="factures">
            <FacturesTab
              projectId={projectId!}
              contractors={contractors ?? []}
              isArchived={isArchived}
            />
          </TabsContent>

          <TabsContent value="lots">
            <div className="space-y-4">
              <div className="flex items-center justify-end">
                <Button onClick={() => {
                  setEditingLot(null);
                  lotForm.reset({ projectId: parseInt(projectId!), lotNumber: "", descriptionFr: "", descriptionUk: null });
                  setLotDialogOpen(true);
                }} disabled={isArchived} data-testid="button-new-lot">
                  <Plus size={14} />
                  <span className="text-[9px] font-bold uppercase tracking-widest">New Lot</span>
                </Button>
              </div>
              <LuxuryCard data-testid="card-lots-tab">
                {lotsList && lotsList.length > 0 ? (
                  <div className="space-y-3">
                    <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground mb-4">
                      Lots ({lotsList.length})
                    </h3>
                    {lotsList.map((lot) => (
                      <div
                        key={lot.id}
                        className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] flex items-center gap-3 flex-wrap"
                        data-testid={`row-lot-${lot.id}`}
                      >
                        <TechnicalLabel>Lot {lot.lotNumber}</TechnicalLabel>
                        <span className="text-[12px] text-foreground" data-testid={`text-lot-fr-${lot.id}`}>{lot.descriptionFr}</span>
                        {lot.descriptionUk ? (
                          <span className="text-[11px] text-muted-foreground italic" data-testid={`text-lot-uk-${lot.id}`}>({lot.descriptionUk})</span>
                        ) : (
                          <span className="text-[11px] text-amber-600 dark:text-amber-400 italic" data-testid={`text-lot-uk-missing-${lot.id}`}>(no English description)</span>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-auto h-7 px-2 gap-1"
                          disabled={isArchived}
                          onClick={() => {
                            setEditingLot(lot);
                            lotForm.reset({
                              projectId: parseInt(projectId!),
                              lotNumber: lot.lotNumber,
                              descriptionFr: lot.descriptionFr,
                              descriptionUk: lot.descriptionUk,
                            });
                            setLotDialogOpen(true);
                          }}
                          data-testid={`button-edit-lot-${lot.id}`}
                        >
                          <Pencil size={11} />
                          <span className="text-[9px] font-bold uppercase tracking-widest">Edit</span>
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-muted-foreground text-center py-8">
                    No Lots defined for this project.
                  </p>
                )}
              </LuxuryCard>
              <Dialog open={lotDialogOpen} onOpenChange={(open) => { setLotDialogOpen(open); if (!open) setEditingLot(null); }}>
                <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle className="text-[16px] font-black uppercase tracking-tight">
                      {editingLot ? `Edit Lot ${editingLot.lotNumber}` : "New Lot"}
                    </DialogTitle>
                    {editingLot && (
                      <DialogDescription className="text-[11px]">
                        Override the descriptions for this project's lot. Other projects are not affected.
                      </DialogDescription>
                    )}
                  </DialogHeader>
                  <Form {...lotForm}>
                    <form onSubmit={lotForm.handleSubmit((d) => editingLot ? updateLotMutation.mutate({ id: editingLot.id, data: d }) : createLotMutation.mutate(d))} className="space-y-4">
                      <FormField control={lotForm.control} name="lotNumber" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Lot Number</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} type="number" onChange={(e) => field.onChange(parseInt(e.target.value))} data-testid="input-lot-number" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={lotForm.control} name="descriptionFr" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Description (FR)</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} placeholder="ex: Gros Oeuvre" data-testid="input-lot-desc-fr" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={lotForm.control} name="descriptionUk" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Description (EN)</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} placeholder="ex: Structural Works" data-testid="input-lot-desc-uk" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <Button type="submit" className="w-full" disabled={createLotMutation.isPending || updateLotMutation.isPending} data-testid="button-submit-lot">
                        <span className="text-[9px] font-bold uppercase tracking-widest">
                          {editingLot
                            ? (updateLotMutation.isPending ? "Saving..." : "Save Changes")
                            : (createLotMutation.isPending ? "Creating..." : "Create Lot")}
                        </span>
                      </Button>
                    </form>
                  </Form>
                </DialogContent>
              </Dialog>
            </div>
          </TabsContent>

          {project.hasMarche && (
            <TabsContent value="marche">
              <div className="space-y-4">
                <div className="flex items-center justify-end">
                  <Button onClick={() => {
                    marcheForm.reset({
                      projectId: parseInt(projectId!), contractorId: 0, marcheNumber: null,
                      priceType: "forfaitaire", totalHt: "0.00", totalTtc: "0.00",
                      retenueGarantiePercent: "5.00", paymentSchedule: null, signedDate: null, status: "draft",
                    });
                    setMarcheDialogOpen(true);
                  }} disabled={isArchived} data-testid="button-new-marche">
                    <Plus size={14} />
                    <span className="text-[9px] font-bold uppercase tracking-widest">New Marché</span>
                  </Button>
                </div>
                <LuxuryCard data-testid="card-marche-tab">
                  {marchesList && marchesList.length > 0 ? (
                    <div className="space-y-3">
                      <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground mb-4">
                        Marchés ({marchesList.length})
                      </h3>
                      {marchesList.map((m) => (
                        <div
                          key={m.id}
                          className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] flex items-center justify-between gap-3 flex-wrap"
                          data-testid={`row-marche-${m.id}`}
                        >
                          <div>
                            {m.marcheNumber && <TechnicalLabel>{m.marcheNumber}</TechnicalLabel>}
                            <p className="text-[12px] text-foreground mt-0.5">
                              {m.priceType === "forfaitaire" ? "Forfaitaire" : "Unitaire"}
                            </p>
                            <span className="text-[10px] text-muted-foreground">{getContractorName(m.contractorId)}</span>
                          </div>
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-[12px] font-semibold text-foreground">{formatCurrency(parseFloat(m.totalHt))} HT</span>
                            <StatusBadge status={m.status} />
                          </div>
                        </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12px] text-muted-foreground text-center py-8">
                    No Marché for this project.
                  </p>
                )}
              </LuxuryCard>
              <Dialog open={marcheDialogOpen} onOpenChange={setMarcheDialogOpen}>
                <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle className="text-[16px] font-black uppercase tracking-tight">New Marché</DialogTitle>
                  </DialogHeader>
                  <Form {...marcheForm}>
                    <form onSubmit={marcheForm.handleSubmit((d) => createMarcheMutation.mutate(d))} className="space-y-4">
                      <FormField control={marcheForm.control} name="contractorId" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Contractor</TechnicalLabel></FormLabel>
                          <Select onValueChange={(v) => field.onChange(parseInt(v))} value={field.value ? String(field.value) : ""}>
                            <FormControl><SelectTrigger data-testid="select-marche-contractor"><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                            <SelectContent>
                              {(contractors ?? []).filter((c) => !c.archidocOrphanedAt).map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={marcheForm.control} name="marcheNumber" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Marché Number</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} placeholder="ex: MTP-2024-001" data-testid="input-marche-number" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={marcheForm.control} name="priceType" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Price Type</TechnicalLabel></FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl><SelectTrigger data-testid="select-marche-price"><SelectValue /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="forfaitaire">Forfaitaire</SelectItem>
                              <SelectItem value="unitaire">Unitaire</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <div className="grid grid-cols-2 gap-4">
                        <FormField control={marcheForm.control} name="totalHt" render={({ field }) => (
                          <FormItem>
                            <FormLabel><TechnicalLabel>Total HT</TechnicalLabel></FormLabel>
                            <FormControl><Input {...field} type="number" step="0.01" data-testid="input-marche-ht" /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                        <FormField control={marcheForm.control} name="totalTtc" render={({ field }) => (
                          <FormItem>
                            <FormLabel><TechnicalLabel>Total TTC</TechnicalLabel></FormLabel>
                            <FormControl><Input {...field} type="number" step="0.01" data-testid="input-marche-ttc" /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )} />
                      </div>
                      <FormField control={marcheForm.control} name="retenueGarantiePercent" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Retenue de Garantie (%)</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} value={field.value ?? "5.00"} type="number" step="0.01" data-testid="input-marche-retenue" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <Button type="submit" className="w-full" disabled={createMarcheMutation.isPending} data-testid="button-submit-marche">
                        <span className="text-[9px] font-bold uppercase tracking-widest">
                          {createMarcheMutation.isPending ? "Creating..." : "Create Marché"}
                        </span>
                      </Button>
                    </form>
                  </Form>
                </DialogContent>
              </Dialog>
            </div>
            </TabsContent>
          )}

          <TabsContent value="certificats">
            <div className="space-y-4">
              <div className="flex items-center justify-end">
                <Button onClick={openCreateCert} disabled={isArchived} data-testid="button-new-cert-tab">
                  <Plus size={14} />
                  <span className="text-[9px] font-bold uppercase tracking-widest">New Certificat</span>
                </Button>
              </div>
              {certificatsList && certificatsList.length > 0 ? (
                <div className="space-y-3">
                  {certificatsList.map((c) => {
                    const nextStatus = getNextCertStatus(c.status);
                    const nextLabel = getNextCertLabel(c.status);
                    return (
                      <LuxuryCard key={c.id} data-testid={`card-certificat-tab-${c.id}`}>
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div>
                            <TechnicalLabel data-testid={`text-cert-ref-tab-${c.id}`}>{c.certificateRef}</TechnicalLabel>
                            <p className="text-[12px] text-foreground mt-0.5">{getContractorName(c.contractorId)}</p>
                            {c.dateIssued && (
                              <p className="text-[10px] text-muted-foreground mt-0.5">{c.dateIssued}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-3 flex-wrap">
                            <div className="text-right">
                              <span className="text-[14px] font-semibold text-foreground" data-testid={`text-cert-ttc-tab-${c.id}`}>
                                {formatCurrency(parseFloat(c.netToPayTtc))}
                              </span>
                              <p className="text-[9px] text-muted-foreground">TTC</p>
                            </div>
                            <StatusBadge status={c.status} />
                            {nextStatus && nextLabel && (
                              <Button
                                variant="outline"
                                onClick={() => updateCertStatusMutation.mutate({ id: c.id, status: nextStatus })}
                                disabled={updateCertStatusMutation.isPending || isArchived}
                                data-testid={`button-advance-cert-tab-${c.id}`}
                              >
                                <ChevronRight size={12} />
                                <span className="text-[8px] font-bold uppercase tracking-widest">{nextLabel}</span>
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-[10px] px-3 gap-1.5"
                              onClick={() => previewCertPdf(c.id)}
                              disabled={previewingCertId === c.id}
                              data-testid={`button-preview-cert-${c.id}`}
                            >
                              {previewingCertId === c.id ? <Loader2 size={12} className="animate-spin" /> : <FileCheck size={12} />}
                              Preview PDF
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setViewingCert(c)}
                              data-testid={`button-view-cert-tab-${c.id}`}
                            >
                              <Eye size={14} />
                            </Button>
                          </div>
                        </div>
                        <div className="grid grid-cols-4 gap-3 mt-3 pt-3 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                          <div>
                            <TechnicalLabel>Travaux HT</TechnicalLabel>
                            <p className="text-[11px] font-semibold text-foreground mt-0.5">{formatCurrency(parseFloat(c.totalWorksHt))}</p>
                          </div>
                          <div>
                            <TechnicalLabel>PV/MV</TechnicalLabel>
                            <p className="text-[11px] font-semibold text-foreground mt-0.5">{formatCurrency(parseFloat(c.pvMvAdjustment ?? "0"))}</p>
                          </div>
                          <div>
                            <TechnicalLabel>Retenue</TechnicalLabel>
                            <p className="text-[11px] font-semibold text-foreground mt-0.5">{formatCurrency(parseFloat(c.retenueGarantie ?? "0"))}</p>
                          </div>
                          <div>
                            <TechnicalLabel>Net HT</TechnicalLabel>
                            <p className="text-[11px] font-semibold text-foreground mt-0.5">{formatCurrency(parseFloat(c.netToPayHt))}</p>
                          </div>
                        </div>
                      </LuxuryCard>
                    );
                  })}
                </div>
              ) : (
                <LuxuryCard data-testid="card-empty-certs-tab">
                  <p className="text-[12px] text-muted-foreground text-center py-8">
                    No Certificat de Paiement for this project.
                  </p>
                </LuxuryCard>
              )}
            </div>

            {viewingCert && (
              <Dialog open onOpenChange={() => setViewingCert(null)}>
                <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle className="text-[16px] font-black uppercase tracking-tight">
                      Certificat {viewingCert.certificateRef}
                    </DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <StatusBadge status={viewingCert.status} />
                      {viewingCert.dateIssued && <span className="text-[11px] text-muted-foreground">{viewingCert.dateIssued}</span>}
                    </div>
                    <div>
                      <TechnicalLabel>Contractor</TechnicalLabel>
                      <p className="text-[13px] font-semibold text-foreground mt-1" data-testid="text-cert-view-contractor">
                        {getContractorName(viewingCert.contractorId)}
                      </p>
                    </div>
                    <div className="space-y-2 p-4 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                      <div className="flex items-center justify-between gap-2">
                        <TechnicalLabel>Total Works HT</TechnicalLabel>
                        <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(viewingCert.totalWorksHt))}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <TechnicalLabel>PV/MV</TechnicalLabel>
                        <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(viewingCert.pvMvAdjustment ?? "0"))}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <TechnicalLabel>Previous Payments</TechnicalLabel>
                        <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(viewingCert.previousPayments ?? "0"))}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <TechnicalLabel>Retenue de Garantie</TechnicalLabel>
                        <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(viewingCert.retenueGarantie ?? "0"))}</span>
                      </div>
                      <div className="border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] pt-3">
                        <div className="flex items-center justify-between gap-2">
                          <TechnicalLabel>Net HT</TechnicalLabel>
                          <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(viewingCert.netToPayHt))}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-1">
                          <TechnicalLabel>TVA</TechnicalLabel>
                          <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(viewingCert.tvaAmount))}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                          <span className="text-[11px] font-black uppercase tracking-widest text-foreground">Net TTC</span>
                          <span className="text-[16px] font-bold text-foreground">{formatCurrency(parseFloat(viewingCert.netToPayTtc))}</span>
                        </div>
                      </div>
                    </div>
                    {viewingCert.notes && (
                      <div>
                        <TechnicalLabel>Notes</TechnicalLabel>
                        <p className="text-[12px] text-muted-foreground mt-1">{viewingCert.notes}</p>
                      </div>
                    )}
                  </div>
                </DialogContent>
              </Dialog>
            )}

            <Dialog open={certDialogOpen} onOpenChange={setCertDialogOpen}>
              <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="text-[16px] font-black uppercase tracking-tight">New Certificat</DialogTitle>
                </DialogHeader>
                <Form {...certForm}>
                  <form onSubmit={certForm.handleSubmit((d) => createCertMutation.mutate(d))} className="space-y-4">
                    <FormField control={certForm.control} name="contractorId" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Contractor</TechnicalLabel></FormLabel>
                        <Select onValueChange={(v) => field.onChange(parseInt(v))} value={field.value ? String(field.value) : ""}>
                          <FormControl><SelectTrigger data-testid="select-cert-contractor-tab"><SelectValue placeholder="Select" /></SelectTrigger></FormControl>
                          <SelectContent>
                            {(contractors ?? []).filter((c) => !c.archidocOrphanedAt).map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={certForm.control} name="certificateRef" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Reference</TechnicalLabel></FormLabel>
                        <FormControl><Input {...field} placeholder="ex: C43" data-testid="input-cert-ref-tab" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={certForm.control} name="dateIssued" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Date</TechnicalLabel></FormLabel>
                        <FormControl><Input type="date" {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} data-testid="input-cert-date-tab" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={certForm.control} name="totalWorksHt" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Total Works HT</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcCert()} data-testid="input-cert-works-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={certForm.control} name="pvMvAdjustment" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>PV/MV</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} value={field.value ?? "0.00"} type="number" step="0.01" onBlur={() => recalcCert()} data-testid="input-cert-pvmv-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={certForm.control} name="previousPayments" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Previous Payments</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} value={field.value ?? "0.00"} type="number" step="0.01" onBlur={() => recalcCert()} data-testid="input-cert-prev-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={certForm.control} name="retenueGarantie" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Retenue de Garantie</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} value={field.value ?? "0.00"} type="number" step="0.01" onBlur={() => recalcCert()} data-testid="input-cert-retenue-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <div className="p-4 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] space-y-2">
                      <TechnicalLabel>Summary</TechnicalLabel>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-muted-foreground">Net HT</span>
                        <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(certForm.watch("netToPayHt") || "0"))}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-muted-foreground">TVA</span>
                        <span className="text-[13px] font-semibold text-foreground">{formatCurrency(parseFloat(certForm.watch("tvaAmount") || "0"))}</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 pt-2 border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)]">
                        <span className="text-[11px] font-black uppercase tracking-widest">Net TTC</span>
                        <span className="text-[16px] font-bold text-foreground">{formatCurrency(parseFloat(certForm.watch("netToPayTtc") || "0"))}</span>
                      </div>
                    </div>
                    <FormField control={certForm.control} name="notes" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Notes</TechnicalLabel></FormLabel>
                        <FormControl><Textarea {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} className="resize-none" data-testid="input-cert-notes-tab" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <Button type="submit" className="w-full" disabled={createCertMutation.isPending} data-testid="button-submit-cert-tab">
                      <span className="text-[9px] font-bold uppercase tracking-widest">
                        {createCertMutation.isPending ? "Creating..." : "Create Certificat"}
                      </span>
                    </Button>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </TabsContent>

          <TabsContent value="honoraires">
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="grid grid-cols-3 gap-4 flex-1">
                  <div>
                    <TechnicalLabel>Total Honoraires</TechnicalLabel>
                    <p className="text-[16px] font-light text-foreground mt-1" data-testid="text-tab-fee-total">
                      {formatCurrency((feesList ?? []).reduce((s, f) => s + parseFloat(f.feeAmountHt), 0))}
                    </p>
                  </div>
                  <div>
                    <TechnicalLabel>Invoiced</TechnicalLabel>
                    <p className="text-[16px] font-light text-emerald-600 dark:text-emerald-400 mt-1" data-testid="text-tab-fee-invoiced">
                      {formatCurrency((feesList ?? []).reduce((s, f) => s + parseFloat(f.invoicedAmount ?? "0"), 0))}
                    </p>
                  </div>
                  <div>
                    <TechnicalLabel>Remaining</TechnicalLabel>
                    <p className="text-[16px] font-light text-amber-600 dark:text-amber-400 mt-1" data-testid="text-tab-fee-remaining">
                      {formatCurrency((feesList ?? []).reduce((s, f) => s + parseFloat(f.feeAmountHt) - parseFloat(f.invoicedAmount ?? "0"), 0))}
                    </p>
                  </div>
                </div>
                <Button onClick={openCreateFee} disabled={isArchived} data-testid="button-new-fee-tab">
                  <Plus size={14} />
                  <span className="text-[9px] font-bold uppercase tracking-widest">New Fee</span>
                </Button>
              </div>

              {feesList && feesList.length > 0 ? (
                <div className="space-y-4">
                  {feesList.map((f) => {
                    const feeTypeLabel = f.feeType === "works_percentage" ? "% Works" : f.feeType === "conception" ? "Conception" : "Planning";
                    const entries = (feeEntries ?? []).filter((e) => e.feeId === f.id);
                    const feeHt = parseFloat(f.feeAmountHt);
                    const invoiced = parseFloat(f.invoicedAmount ?? "0");
                    const progress = feeHt > 0 ? Math.min((invoiced / feeHt) * 100, 100) : 0;

                    return (
                      <LuxuryCard key={f.id} data-testid={`card-fee-tab-${f.id}`}>
                        <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground">{feeTypeLabel}</h3>
                              <StatusBadge status={f.status} />
                            </div>
                            {f.feeRate && <p className="text-[11px] text-muted-foreground mt-0.5">Rate: {f.feeRate}%</p>}
                            {f.pennylaneRef && <p className="text-[10px] text-muted-foreground">PL: {f.pennylaneRef}</p>}
                          </div>
                          <Button variant="outline" onClick={() => openCreateEntry(f.id)} disabled={isArchived} data-testid={`button-add-entry-tab-${f.id}`}>
                            <Plus size={12} />
                            <span className="text-[8px] font-bold uppercase tracking-widest">Entry</span>
                          </Button>
                        </div>

                        <div className="grid grid-cols-3 gap-4 mb-3">
                          <div>
                            <TechnicalLabel>Amount HT</TechnicalLabel>
                            <p className="text-[13px] font-semibold text-foreground mt-0.5" data-testid={`text-fee-ht-tab-${f.id}`}>{formatCurrency(feeHt)}</p>
                          </div>
                          <div>
                            <TechnicalLabel>Invoiced</TechnicalLabel>
                            <p className="text-[13px] font-semibold text-emerald-600 dark:text-emerald-400 mt-0.5">{formatCurrency(invoiced)}</p>
                          </div>
                          <div>
                            <TechnicalLabel>Remaining</TechnicalLabel>
                            <p className="text-[13px] font-semibold text-amber-600 dark:text-amber-400 mt-0.5">{formatCurrency(feeHt - invoiced)}</p>
                          </div>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 mb-3">
                          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} />
                        </div>

                        {entries.length > 0 && (
                          <div className="border-t border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] pt-3">
                            <TechnicalLabel>Entries ({entries.length})</TechnicalLabel>
                            <div className="mt-2 space-y-2">
                              {entries.map((entry) => (
                                <div
                                  key={entry.id}
                                  className="p-3 rounded-xl border border-[rgba(0,0,0,0.05)] dark:border-[rgba(255,255,255,0.06)] flex items-center justify-between gap-3 flex-wrap"
                                  data-testid={`row-entry-tab-${entry.id}`}
                                >
                                  <div>
                                    {entry.invoiceId && (() => {
                                      const linkedInv = (projectInvoices ?? []).find(i => i.id === entry.invoiceId);
                                      const linkedContractor = linkedInv ? contractors?.find(c => c.id === linkedInv.contractorId) : null;
                                      return linkedInv ? (
                                        <p className="text-[10px] font-semibold text-[#0B2545] mb-0.5">
                                          Facture #{linkedInv.invoiceNumber}{linkedContractor ? ` — ${linkedContractor.name}` : ""}
                                        </p>
                                      ) : null;
                                    })()}
                                    <span className="text-[11px] text-foreground">Base: {formatCurrency(parseFloat(entry.baseHt))} x {entry.feeRate}%</span>
                                    {entry.pennylaneInvoiceRef && <p className="text-[10px] text-muted-foreground mt-0.5">Ref: {entry.pennylaneInvoiceRef}</p>}
                                    {entry.status === "invoiced" && !entry.pennylaneInvoiceRef && (
                                      <div className="flex items-center gap-1 mt-0.5 text-amber-600 dark:text-amber-400" data-testid={`warning-missing-ref-${entry.id}`}>
                                        <AlertTriangle size={10} />
                                        <span className="text-[10px] font-semibold">Missing invoice ref</span>
                                      </div>
                                    )}
                                    {entry.dateInvoiced && <p className="text-[10px] text-muted-foreground">{entry.dateInvoiced}</p>}
                                  </div>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[12px] font-semibold text-foreground">{formatCurrency(parseFloat(entry.feeAmount))}</span>
                                    <StatusBadge status={entry.status} />
                                    {entry.status === "pending" && (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 text-[10px] px-2 border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                                        onClick={() => { setMarkInvoicedEntryId(entry.id); setMarkInvoicedRef(""); }}
                                        disabled={isArchived}
                                        data-testid={`button-mark-invoiced-${entry.id}`}
                                      >
                                        <FileCheck size={12} className="mr-1" />
                                        Mark Invoiced
                                      </Button>
                                    )}
                                    <Button variant="ghost" size="icon" onClick={() => openEditEntry(entry)} disabled={isArchived} data-testid={`button-edit-entry-tab-${entry.id}`}>
                                      <Pencil size={12} />
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </LuxuryCard>
                    );
                  })}
                </div>
              ) : (
                <LuxuryCard data-testid="card-empty-fees-tab">
                  <p className="text-[12px] text-muted-foreground text-center py-8">
                    No Honoraires defined for this project.
                  </p>
                </LuxuryCard>
              )}
            </div>

            <Dialog open={feeDialogOpen} onOpenChange={setFeeDialogOpen}>
              <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="text-[16px] font-black uppercase tracking-tight">New Fee</DialogTitle>
                </DialogHeader>
                <Form {...feeForm}>
                  <form onSubmit={feeForm.handleSubmit((d) => createFeeMutation.mutate(d))} className="space-y-4">
                    <FormField control={feeForm.control} name="feeType" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Type</TechnicalLabel></FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl><SelectTrigger data-testid="select-fee-type-tab"><SelectValue /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="works_percentage">% Works</SelectItem>
                            <SelectItem value="conception">Conception</SelectItem>
                            <SelectItem value="planning">Planning</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={feeForm.control} name="baseAmountHt" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Base HT</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcFee()} data-testid="input-fee-base-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={feeForm.control} name="feeRate" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Rate (%)</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} type="number" step="0.01" onBlur={() => recalcFee()} data-testid="input-fee-rate-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <FormField control={feeForm.control} name="feeAmountHt" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Fee Amount HT</TechnicalLabel></FormLabel>
                        <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcFee()} data-testid="input-fee-ht-tab" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={feeForm.control} name="pennylaneRef" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Ref Penny Lane</TechnicalLabel></FormLabel>
                        <FormControl><Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} data-testid="input-fee-pl-tab" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <Button type="submit" className="w-full" disabled={createFeeMutation.isPending} data-testid="button-submit-fee-tab">
                      <span className="text-[9px] font-bold uppercase tracking-widest">
                        {createFeeMutation.isPending ? "Creating..." : "Create Fee"}
                      </span>
                    </Button>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>

            <Dialog open={entryDialogOpen} onOpenChange={setEntryDialogOpen}>
              <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="text-[16px] font-black uppercase tracking-tight">
                    {editingEntryId ? "Edit Entry" : "New Entry"}
                  </DialogTitle>
                </DialogHeader>
                <Form {...entryForm}>
                  <form onSubmit={entryForm.handleSubmit((d) => editingEntryId ? updateEntryMutation.mutate({ id: editingEntryId, data: d }) : createEntryMutation.mutate(d))} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <FormField control={entryForm.control} name="baseHt" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Base HT</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcEntry()} data-testid="input-entry-base-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={entryForm.control} name="feeRate" render={({ field }) => (
                        <FormItem>
                          <FormLabel><TechnicalLabel>Rate (%)</TechnicalLabel></FormLabel>
                          <FormControl><Input {...field} type="number" step="0.01" onBlur={() => recalcEntry()} data-testid="input-entry-rate-tab" /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                    </div>
                    <FormField control={entryForm.control} name="feeAmount" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Amount</TechnicalLabel></FormLabel>
                        <FormControl><Input {...field} type="number" step="0.01" readOnly data-testid="input-entry-amount-tab" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={entryForm.control} name="pennylaneInvoiceRef" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Penny Lane Invoice Ref</TechnicalLabel></FormLabel>
                        <FormControl><Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} data-testid="input-entry-pl-tab" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={entryForm.control} name="dateInvoiced" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Invoice Date</TechnicalLabel></FormLabel>
                        <FormControl><Input type="date" {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} data-testid="input-entry-date-tab" /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <FormField control={entryForm.control} name="status" render={({ field }) => (
                      <FormItem>
                        <FormLabel><TechnicalLabel>Status</TechnicalLabel></FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl><SelectTrigger data-testid="select-entry-status-tab"><SelectValue /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="pending">Pending</SelectItem>
                            <SelectItem value="invoiced">Invoiced</SelectItem>
                            <SelectItem value="paid">Paid</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                    <Button type="submit" className="w-full" disabled={createEntryMutation.isPending || updateEntryMutation.isPending} data-testid="button-submit-entry-tab">
                      <span className="text-[9px] font-bold uppercase tracking-widest">
                        {(createEntryMutation.isPending || updateEntryMutation.isPending) ? "Saving..." : editingEntryId ? "Update" : "Create Entry"}
                      </span>
                    </Button>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>

            <Dialog open={markInvoicedEntryId !== null} onOpenChange={(open) => { if (!open) { setMarkInvoicedEntryId(null); setMarkInvoicedRef(""); } }}>
              <DialogContent className="max-w-sm" data-testid="dialog-mark-invoiced">
                <DialogHeader>
                  <DialogTitle className="text-[14px]">Mark Commission as Invoiced</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 pt-2">
                  <p className="text-[12px] text-muted-foreground">
                    Enter the invoice number from your accounting software (optional — you can add it later).
                  </p>
                  <div>
                    <TechnicalLabel>Accounting Invoice Number</TechnicalLabel>
                    <Input
                      value={markInvoicedRef}
                      onChange={(e) => setMarkInvoicedRef(e.target.value)}
                      placeholder="e.g. FA-2026-001"
                      className="mt-1"
                      data-testid="input-accounting-invoice-ref"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => { setMarkInvoicedEntryId(null); setMarkInvoicedRef(""); }}
                      data-testid="button-cancel-mark-invoiced"
                    >
                      <span className="text-[9px] font-bold uppercase tracking-widest">Cancel</span>
                    </Button>
                    <Button
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                      disabled={markInvoicedMutation.isPending}
                      onClick={() => {
                        if (markInvoicedEntryId) {
                          markInvoicedMutation.mutate({
                            entryId: markInvoicedEntryId,
                            pennylaneInvoiceRef: markInvoicedRef.trim() || undefined,
                          });
                        }
                      }}
                      data-testid="button-confirm-mark-invoiced"
                    >
                      <FileCheck size={14} className="mr-1" />
                      <span className="text-[9px] font-bold uppercase tracking-widest">
                        {markInvoicedMutation.isPending ? "Saving..." : "Mark Invoiced"}
                      </span>
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </TabsContent>

          <TabsContent value="documents">
            <div className="space-y-4">
              <div className="flex items-center justify-end">
                <Button onClick={handleFileUpload} disabled={uploadDocMutation.isPending || isArchived} data-testid="button-upload-doc">
                  <Upload size={14} />
                  <span className="text-[9px] font-bold uppercase tracking-widest">
                    {uploadDocMutation.isPending ? "Uploading..." : "Upload Document"}
                  </span>
                </Button>
              </div>
              {projectDocuments && projectDocuments.length > 0 ? (
                <div className="space-y-2">
                  {projectDocuments.map((doc) => (
                    <LuxuryCard key={doc.id} className="p-4" data-testid={`card-project-doc-${doc.id}`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-950/30 flex items-center justify-center flex-shrink-0">
                            <FileText size={14} className="text-blue-600" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-[12px] font-semibold text-foreground truncate" data-testid={`text-doc-name-${doc.id}`}>
                              {doc.fileName}
                            </p>
                            <div className="flex items-center gap-2 mt-0.5">
                              {doc.documentType && (
                                <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                                  {doc.documentType}
                                </span>
                              )}
                              <span className="text-[10px] text-muted-foreground">
                                {doc.sourceEmailDocumentId ? "Auto-extracted" : "Manual upload"}
                              </span>
                              {doc.createdAt && (
                                <span className="text-[10px] text-muted-foreground">
                                  {new Date(doc.createdAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" })}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <a href={doc.sourceEmailDocumentId ? `/api/email-documents/${doc.sourceEmailDocumentId}/download` : `/api/documents/${doc.id}/download`} download>
                          <Button variant="ghost" size="icon" className="h-8 w-8" data-testid={`button-download-doc-${doc.id}`}>
                            <Download size={14} />
                          </Button>
                        </a>
                      </div>
                    </LuxuryCard>
                  ))}
                </div>
              ) : (
                <LuxuryCard data-testid="card-empty-docs">
                  <div className="text-center py-8">
                    <FileText size={28} className="mx-auto mb-3 text-muted-foreground" />
                    <p className="text-[12px] text-muted-foreground">No documents for this project yet.</p>
                    <p className="text-[10px] text-muted-foreground mt-1">Upload documents manually or they will appear here when extracted from Gmail.</p>
                  </div>
                </LuxuryCard>
              )}
            </div>
          </TabsContent>

          <TabsContent value="communications">
            <div className="space-y-6">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="text-center">
                    <TechnicalLabel>Sent</TechnicalLabel>
                    <p className="text-[16px] font-semibold text-emerald-600 mt-1" data-testid="text-comms-sent">
                      {projectComms?.filter(c => c.status === "sent").length ?? 0}
                    </p>
                  </div>
                  <div className="text-center">
                    <TechnicalLabel>Queued</TechnicalLabel>
                    <p className="text-[16px] font-semibold text-amber-600 mt-1" data-testid="text-comms-queued">
                      {projectComms?.filter(c => c.status === "queued").length ?? 0}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  {certificatsList && certificatsList.filter(c => c.status === "ready").length > 0 && (
                    <div className="flex gap-1">
                      {certificatsList.filter(c => c.status === "ready").map(cert => (
                        <Button
                          key={cert.id}
                          variant="outline"
                          size="sm"
                          onClick={() => sendCertMutation.mutate(cert.id)}
                          disabled={sendCertMutation.isPending || isArchived}
                          data-testid={`button-send-cert-${cert.id}`}
                        >
                          <Send size={12} />
                          <span className="text-[8px] font-bold uppercase tracking-widest">Send {cert.certificateRef}</span>
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {projectComms && projectComms.length > 0 ? (
                <div className="space-y-3">
                  <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground">
                    Communication History
                  </h3>
                  {projectComms.map((comm) => {
                    const typeIcon = comm.type === "certificat_sent" ? FileCheck :
                      comm.type === "payment_chase" ? Clock : MessageSquare;
                    const TypeIcon = typeIcon;
                    return (
                      <LuxuryCard key={comm.id} className="p-4" data-testid={`card-comm-${comm.id}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3 min-w-0">
                            <div className="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-950/30 flex items-center justify-center flex-shrink-0">
                              <TypeIcon size={14} className="text-indigo-600" />
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-[12px] font-semibold text-foreground truncate">{comm.subject}</p>
                                <StatusBadge status={comm.status} size="sm" />
                              </div>
                              <p className="text-[10px] text-muted-foreground mt-0.5">
                                To: {comm.recipientName || comm.recipientEmail || "—"}
                                <span className="mx-1">·</span>
                                {comm.sentAt ? new Date(comm.sentAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "Not sent"}
                              </p>
                              <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300 mt-1 inline-block">
                                {comm.type.replace(/_/g, " ")}
                              </span>
                            </div>
                          </div>
                          {(comm.status === "draft" || comm.status === "queued") && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => sendCommMutation.mutate(comm.id)}
                              disabled={sendCommMutation.isPending || isArchived}
                              data-testid={`button-send-comm-${comm.id}`}
                            >
                              <Send size={12} />
                              <span className="text-[8px] font-bold uppercase tracking-widest">Send</span>
                            </Button>
                          )}
                        </div>
                      </LuxuryCard>
                    );
                  })}
                </div>
              ) : (
                <LuxuryCard data-testid="card-empty-comms">
                  <div className="text-center py-8">
                    <MessageSquare size={28} className="mx-auto mb-3 text-muted-foreground" />
                    <p className="text-[12px] text-muted-foreground">No communications yet.</p>
                    <p className="text-[10px] text-muted-foreground mt-1">Send Certificats and chase payments from this tab.</p>
                  </div>
                </LuxuryCard>
              )}

              {reminders && reminders.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-[14px] font-black uppercase tracking-tight text-foreground">
                    Payment Reminders
                  </h3>
                  {reminders.map((rem) => (
                    <LuxuryCard key={rem.id} className="p-4" data-testid={`card-reminder-${rem.id}`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-xl bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center flex-shrink-0">
                            <Clock size={14} className="text-amber-600" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-[12px] font-semibold text-foreground capitalize">{rem.reminderType} reminder</p>
                              <StatusBadge status={rem.status} size="sm" />
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              Scheduled: {rem.scheduledDate}
                              {rem.recipientEmail && <span className="ml-1">· To: {rem.recipientEmail}</span>}
                            </p>
                          </div>
                        </div>
                        {rem.status === "scheduled" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => cancelReminderMutation.mutate(rem.id)}
                            data-testid={`button-cancel-reminder-${rem.id}`}
                          >
                            <span className="text-[8px] font-bold uppercase tracking-widest text-rose-500">Cancel</span>
                          </Button>
                        )}
                      </div>
                    </LuxuryCard>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
