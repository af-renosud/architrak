import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { SectionHeader } from "@/components/ui/section-header";
import { LuxuryCard } from "@/components/ui/luxury-card";
import { TechnicalLabel } from "@/components/ui/technical-label";
import { Building2, Plus, Mail, Phone, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { insertContractorSchema } from "@shared/schema";
import type { Contractor } from "@shared/schema";
import { z } from "zod";

const contractorFormSchema = insertContractorSchema.extend({
  name: z.string().min(1, "Le nom est requis"),
});

type ContractorFormValues = z.infer<typeof contractorFormSchema>;

export default function Contractors() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingContractor, setEditingContractor] = useState<Contractor | null>(null);
  const { toast } = useToast();

  const { data: contractors, isLoading } = useQuery<Contractor[]>({
    queryKey: ["/api/contractors"],
  });

  const form = useForm<ContractorFormValues>({
    resolver: zodResolver(contractorFormSchema),
    defaultValues: {
      name: "",
      siret: null,
      address: null,
      email: null,
      phone: null,
      defaultTvaRate: "20.00",
      notes: null,
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: ContractorFormValues) => {
      const res = await apiRequest("POST", "/api/contractors", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contractors"] });
      setDialogOpen(false);
      form.reset();
      toast({ title: "Entreprise créée avec succès" });
    },
    onError: (error: Error) => {
      toast({ title: "Erreur", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<ContractorFormValues> }) => {
      const res = await apiRequest("PATCH", `/api/contractors/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contractors"] });
      setDialogOpen(false);
      setEditingContractor(null);
      form.reset();
      toast({ title: "Entreprise mise à jour" });
    },
    onError: (error: Error) => {
      toast({ title: "Erreur", description: error.message, variant: "destructive" });
    },
  });

  const openCreate = () => {
    setEditingContractor(null);
    form.reset({
      name: "",
      siret: null,
      address: null,
      email: null,
      phone: null,
      defaultTvaRate: "20.00",
      notes: null,
    });
    setDialogOpen(true);
  };

  const openEdit = (contractor: Contractor, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingContractor(contractor);
    form.reset({
      name: contractor.name,
      siret: contractor.siret,
      address: contractor.address,
      email: contractor.email,
      phone: contractor.phone,
      defaultTvaRate: contractor.defaultTvaRate ?? "20.00",
      notes: contractor.notes,
    });
    setDialogOpen(true);
  };

  const onSubmit = (data: ContractorFormValues) => {
    if (editingContractor) {
      updateMutation.mutate({ id: editingContractor.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <AppLayout>
      <div className="space-y-8">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h1 className="text-[22px] font-light uppercase tracking-tight text-foreground" data-testid="text-page-title">
            Entreprises
          </h1>
          <Button onClick={openCreate} data-testid="button-new-contractor">
            <Plus size={14} />
            <span className="text-[9px] font-bold uppercase tracking-widest">Nouvelle Entreprise</span>
          </Button>
        </div>

        <SectionHeader
          icon={Building2}
          title="Toutes les Entreprises"
          subtitle="Répertoire des prestataires"
        />

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-[16px] font-black uppercase tracking-tight">
                {editingContractor ? "Modifier l'entreprise" : "Nouvelle Entreprise"}
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
                        <TechnicalLabel>Nom</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-contractor-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="siret"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>SIRET</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} data-testid="input-contractor-siret" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Email</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} type="email" data-testid="input-contractor-email" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Téléphone</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} data-testid="input-contractor-phone" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Adresse</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} data-testid="input-contractor-address" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="defaultTvaRate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Taux TVA par défaut (%)</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} type="number" step="0.01" data-testid="input-contractor-tva" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        <TechnicalLabel>Notes</TechnicalLabel>
                      </FormLabel>
                      <FormControl>
                        <Textarea {...field} value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value || null)} className="resize-none" data-testid="input-contractor-notes" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" className="w-full" disabled={isPending} data-testid="button-submit-contractor">
                  <span className="text-[9px] font-bold uppercase tracking-widest">
                    {isPending ? "Enregistrement..." : editingContractor ? "Mettre à jour" : "Créer l'entreprise"}
                  </span>
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <LuxuryCard key={i}>
                <Skeleton className="h-4 w-32 mb-2" />
                <Skeleton className="h-3 w-24 mb-4" />
                <Skeleton className="h-3 w-40" />
              </LuxuryCard>
            ))}
          </div>
        ) : contractors && contractors.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {contractors.map((contractor) => (
              <Link key={contractor.id} href={`/entreprises/${contractor.id}`}>
                <LuxuryCard
                  className="cursor-pointer hover-elevate transition-all"
                  data-testid={`card-contractor-${contractor.id}`}
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h3 className="text-[14px] font-bold text-foreground" data-testid={`text-contractor-name-${contractor.id}`}>
                      {contractor.name}
                    </h3>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => openEdit(contractor, e)}
                      data-testid={`button-edit-contractor-${contractor.id}`}
                    >
                      <Pencil size={12} />
                    </Button>
                  </div>
                  {contractor.siret && (
                    <TechnicalLabel data-testid={`text-contractor-siret-${contractor.id}`}>
                      SIRET: {contractor.siret}
                    </TechnicalLabel>
                  )}
                  <div className="mt-3 space-y-1">
                    {contractor.email && (
                      <div className="flex items-center gap-2">
                        <Mail size={12} className="text-muted-foreground" />
                        <span className="text-[11px] text-muted-foreground">{contractor.email}</span>
                      </div>
                    )}
                    {contractor.phone && (
                      <div className="flex items-center gap-2">
                        <Phone size={12} className="text-muted-foreground" />
                        <span className="text-[11px] text-muted-foreground">{contractor.phone}</span>
                      </div>
                    )}
                  </div>
                </LuxuryCard>
              </Link>
            ))}
          </div>
        ) : (
          <LuxuryCard data-testid="card-empty-contractors">
            <p className="text-[12px] text-muted-foreground text-center py-8">
              Aucune entreprise enregistrée. Ajoutez votre première entreprise.
            </p>
          </LuxuryCard>
        )}
      </div>
    </AppLayout>
  );
}
