import { useState, useMemo, useRef } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Upload, Search, Trash2, Tag as TagIcon, AlertTriangle, FileText } from "lucide-react";
import type { Contractor } from "@shared/schema";
import { getBenchmarkUploadErrorTitle } from "@shared/benchmark-upload-errors";

interface BenchmarkTag {
  id: number;
  label: string;
  category: string | null;
}
interface BenchmarkDocument {
  id: number;
  source: string;
  contractorId: number | null;
  externalContractorName: string | null;
  documentDate: string | null;
  notes: string | null;
  pdfFileName: string | null;
  totalHt: string | null;
  needsReview: boolean;
  aiConfidence: number | null;
  createdAt: string;
}
interface BenchmarkItem {
  id: number;
  documentId: number;
  description: string;
  rawQuantity: string | null;
  rawUnit: string | null;
  rawUnitPriceHt: string | null;
  rawTotalHt: string | null;
  normalizedUnit: string | null;
  normalizedUnitPriceHt: string | null;
  needsReview: boolean;
  aiConfidence: number | null;
}
interface SearchRow {
  item: BenchmarkItem;
  document: BenchmarkDocument;
  contractorName: string | null;
  tags: BenchmarkTag[];
}
interface AggregateRow {
  tagId: number;
  tagLabel: string;
  normalizedUnit: string | null;
  count: number;
  minPrice: number;
  medianPrice: number;
  maxPrice: number;
}

const NORMALIZED_UNITS = ["m2", "m3", "ml", "kg", "t", "u", "ens", "forfait", "h", "j", "l"];

function fmt(price: string | number | null | undefined): string {
  if (price == null) return "—";
  const n = Number(price);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function UploadPanel() {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [contractorMode, setContractorMode] = useState<"existing" | "external">("existing");
  const [contractorId, setContractorId] = useState<string>("");
  const [externalName, setExternalName] = useState("");
  const [externalSiret, setExternalSiret] = useState("");
  const [docDate, setDocDate] = useState("");
  const [notes, setNotes] = useState("");

  const { data: contractors } = useQuery<Contractor[]>({ queryKey: ["/api/contractors"] });

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("No file selected");
      const fd = new FormData();
      fd.append("file", file);
      if (contractorMode === "existing" && contractorId) fd.append("contractorId", contractorId);
      if (contractorMode === "external") {
        fd.append("externalContractorName", externalName);
        if (externalSiret) fd.append("externalSiret", externalSiret);
      }
      if (docDate) fd.append("documentDate", docDate);
      if (notes) fd.append("notes", notes);
      const res = await fetch("/api/benchmarks/upload", { method: "POST", body: fd, credentials: "include" });
      const data = await res.json();
      if (!res.ok) {
        const e = new Error(data.message || "Upload failed") as Error & { code?: string };
        e.code = data.code;
        throw e;
      }
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: "Benchmark added",
        description: `Document #${data.document.id} • ${data.itemsCreated} line items ingested`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/benchmarks/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/benchmarks/search"] });
      setFile(null);
      setNotes("");
      if (fileRef.current) fileRef.current.value = "";
    },
    onError: (err: Error & { code?: string }) => {
      const title = getBenchmarkUploadErrorTitle(err.code);
      toast({ title, description: err.message, variant: "destructive" });
    },
  });

  const canSubmit = !!file && (
    (contractorMode === "existing" && !!contractorId) ||
    (contractorMode === "external" && externalName.trim().length > 0)
  );

  return (
    <Card className="p-6 space-y-4" data-testid="card-benchmark-upload">
      <h2 className="text-lg font-semibold">Upload quotation PDF</h2>
      <p className="text-sm text-muted-foreground">
        Upload any quotation PDF. It will be automatically extracted, tagged, and added to the benchmark dataset.
        No project required.
      </p>

      <div className="space-y-2">
        <Label htmlFor="file">PDF file</Label>
        <Input
          ref={fileRef}
          id="file"
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          data-testid="input-benchmark-file"
        />
      </div>

      <div className="space-y-2">
        <Label>Contractor</Label>
        <Tabs value={contractorMode} onValueChange={(v) => setContractorMode(v as "existing" | "external")}>
          <TabsList>
            <TabsTrigger value="existing" data-testid="tab-contractor-existing">Existing contractor</TabsTrigger>
            <TabsTrigger value="external" data-testid="tab-contractor-external">External (one-off)</TabsTrigger>
          </TabsList>
          <TabsContent value="existing" className="pt-3">
            <Select value={contractorId} onValueChange={setContractorId}>
              <SelectTrigger data-testid="select-contractor">
                <SelectValue placeholder="Select contractor" />
              </SelectTrigger>
              <SelectContent>
                {(contractors ?? []).filter(c => !c.archidocOrphanedAt).map(c => (
                  <SelectItem key={c.id} value={String(c.id)} data-testid={`option-contractor-${c.id}`}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </TabsContent>
          <TabsContent value="external" className="pt-3 space-y-3">
            <div className="space-y-2">
              <Label htmlFor="ext-name">External contractor name</Label>
              <Input
                id="ext-name"
                value={externalName}
                onChange={(e) => setExternalName(e.target.value)}
                placeholder="e.g. Piscines Duval"
                data-testid="input-external-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ext-siret">SIRET (optional)</Label>
              <Input
                id="ext-siret"
                value={externalSiret}
                onChange={(e) => setExternalSiret(e.target.value)}
                placeholder="14-digit SIRET"
                data-testid="input-external-siret"
              />
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="doc-date">Quote date</Label>
          <Input
            id="doc-date"
            type="date"
            value={docDate}
            onChange={(e) => setDocDate(e.target.value)}
            data-testid="input-doc-date"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="notes">Notes</Label>
        <Textarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional context"
          data-testid="input-notes"
        />
      </div>

      <Button
        onClick={() => uploadMutation.mutate()}
        disabled={!canSubmit || uploadMutation.isPending}
        data-testid="button-submit-upload"
      >
        <Upload className="w-4 h-4 mr-2" />
        {uploadMutation.isPending ? "Ingesting..." : "Upload & ingest"}
      </Button>
    </Card>
  );
}

function EditTagsDialog({ row, allTags, onClose }: {
  row: SearchRow;
  allTags: BenchmarkTag[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<number>>(new Set(row.tags.map(t => t.id)));

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/benchmarks/items/${row.item.id}/tags`, {
        tagIds: Array.from(selected),
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Tags updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/benchmarks/search"] });
      onClose();
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const toggle = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else if (next.size < 3) next.add(id);
    setSelected(next);
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[80vh] overflow-y-auto" data-testid="dialog-edit-tags">
        <DialogHeader>
          <DialogTitle>Edit tags (max 3)</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{row.item.description}</p>
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {allTags.map(t => (
            <label key={t.id} className="flex items-center gap-2 cursor-pointer text-sm">
              <Checkbox
                checked={selected.has(t.id)}
                onCheckedChange={() => toggle(t.id)}
                disabled={!selected.has(t.id) && selected.size >= 3}
                data-testid={`checkbox-tag-${t.id}`}
              />
              <span>{t.label}</span>
              {t.category && <span className="text-xs text-muted-foreground">({t.category})</span>}
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-cancel-tags">Cancel</Button>
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-tags">
            {saveMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SearchPanel() {
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [contractorFilter, setContractorFilter] = useState<string>("all");
  const [unitFilter, setUnitFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const [editing, setEditing] = useState<SearchRow | null>(null);

  const { data: tags } = useQuery<BenchmarkTag[]>({ queryKey: ["/api/benchmarks/tags"] });
  const { data: contractors } = useQuery<Contractor[]>({ queryKey: ["/api/contractors"] });

  const queryParams = useMemo(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (tagFilter !== "all") p.set("tagIds", tagFilter);
    if (contractorFilter !== "all") p.set("contractorId", contractorFilter);
    if (unitFilter !== "all") p.set("normalizedUnit", unitFilter);
    if (dateFrom) p.set("dateFrom", dateFrom);
    if (dateTo) p.set("dateTo", dateTo);
    if (minPrice) p.set("minPrice", minPrice);
    if (maxPrice) p.set("maxPrice", maxPrice);
    if (needsReviewOnly) p.set("needsReview", "true");
    return p.toString();
  }, [q, tagFilter, contractorFilter, unitFilter, dateFrom, dateTo, minPrice, maxPrice, needsReviewOnly]);

  const { data, isLoading } = useQuery<{ results: SearchRow[]; aggregates: AggregateRow[] }>({
    queryKey: ["/api/benchmarks/search", queryParams],
    queryFn: async () => {
      const res = await fetch(`/api/benchmarks/search?${queryParams}`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/benchmarks/items/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Item deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/benchmarks/search"] });
    },
    onError: (err: Error) => toast({ title: "Delete failed", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <Card className="p-4" data-testid="card-benchmark-filters">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="md:col-span-4">
            <Label htmlFor="q">Search description</Label>
            <div className="relative">
              <Search className="absolute left-2 top-2.5 w-4 h-4 text-muted-foreground" />
              <Input
                id="q"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-8"
                placeholder="e.g. plancher chauffant, pompe..."
                data-testid="input-search"
              />
            </div>
          </div>
          <div>
            <Label>Tag</Label>
            <Select value={tagFilter} onValueChange={setTagFilter}>
              <SelectTrigger data-testid="select-tag-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All tags</SelectItem>
                {(tags ?? []).map(t => (
                  <SelectItem key={t.id} value={String(t.id)}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Contractor</Label>
            <Select value={contractorFilter} onValueChange={setContractorFilter}>
              <SelectTrigger data-testid="select-contractor-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All contractors</SelectItem>
                {(contractors ?? []).map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Unit</Label>
            <Select value={unitFilter} onValueChange={setUnitFilter}>
              <SelectTrigger data-testid="select-unit-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All units</SelectItem>
                {NORMALIZED_UNITS.map(u => (
                  <SelectItem key={u} value={u}>{u}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="from">Date from</Label>
            <Input id="from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} data-testid="input-date-from" />
          </div>
          <div>
            <Label htmlFor="to">Date to</Label>
            <Input id="to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} data-testid="input-date-to" />
          </div>
          <div>
            <Label htmlFor="min">Min unit €</Label>
            <Input id="min" type="number" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} data-testid="input-min-price" />
          </div>
          <div>
            <Label htmlFor="max">Max unit €</Label>
            <Input id="max" type="number" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} data-testid="input-max-price" />
          </div>
          <div className="md:col-span-4 flex items-center gap-2">
            <Checkbox
              id="needs-review"
              checked={needsReviewOnly}
              onCheckedChange={(v) => setNeedsReviewOnly(!!v)}
              data-testid="checkbox-needs-review"
            />
            <label htmlFor="needs-review" className="text-sm cursor-pointer">Show only rows that need review</label>
          </div>
        </div>
      </Card>

      {isLoading ? (
        <Skeleton className="h-32" />
      ) : (
        <>
          {data?.aggregates && data.aggregates.length > 0 && (
            <Card className="p-4" data-testid="card-aggregates">
              <h3 className="text-sm font-semibold mb-3">Price aggregates by tag (€ per unit, HT)</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left border-b">
                      <th className="py-1 pr-4">Tag</th>
                      <th className="py-1 pr-4">Unit</th>
                      <th className="py-1 pr-4">Count</th>
                      <th className="py-1 pr-4">Min</th>
                      <th className="py-1 pr-4">Median</th>
                      <th className="py-1 pr-4">Max</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.aggregates.map(a => (
                      <tr key={`${a.tagId}-${a.normalizedUnit}`} data-testid={`row-aggregate-${a.tagId}`}>
                        <td className="py-1 pr-4">{a.tagLabel}</td>
                        <td className="py-1 pr-4">{a.normalizedUnit ?? "?"}</td>
                        <td className="py-1 pr-4">{a.count}</td>
                        <td className="py-1 pr-4">{fmt(a.minPrice)}</td>
                        <td className="py-1 pr-4 font-medium">{fmt(a.medianPrice)}</td>
                        <td className="py-1 pr-4">{fmt(a.maxPrice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card className="p-4" data-testid="card-results">
            <h3 className="text-sm font-semibold mb-3">
              Results ({data?.results.length ?? 0})
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-1 pr-2">Description</th>
                    <th className="py-1 pr-2">Tags</th>
                    <th className="py-1 pr-2">Contractor</th>
                    <th className="py-1 pr-2">Date</th>
                    <th className="py-1 pr-2">Qty</th>
                    <th className="py-1 pr-2">Unit</th>
                    <th className="py-1 pr-2">Unit €</th>
                    <th className="py-1 pr-2">Total €</th>
                    <th className="py-1 pr-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.results ?? []).map(row => (
                    <tr key={row.item.id} className="border-b hover:bg-muted/30" data-testid={`row-item-${row.item.id}`}>
                      <td className="py-2 pr-2 max-w-md">
                        <div className="flex items-start gap-1">
                          {row.item.needsReview && (
                            <AlertTriangle className="w-3 h-3 text-amber-600 mt-0.5 flex-shrink-0" />
                          )}
                          <span>{row.item.description}</span>
                        </div>
                      </td>
                      <td className="py-2 pr-2">
                        <div className="flex flex-wrap gap-1">
                          {row.tags.map(t => (
                            <Badge key={t.id} variant="secondary" className="text-[10px]">{t.label}</Badge>
                          ))}
                        </div>
                      </td>
                      <td className="py-2 pr-2">{row.contractorName ?? "—"}</td>
                      <td className="py-2 pr-2">{row.document.documentDate ?? "—"}</td>
                      <td className="py-2 pr-2">{row.item.rawQuantity ?? "—"}</td>
                      <td className="py-2 pr-2">
                        {row.item.normalizedUnit ?? row.item.rawUnit ?? "—"}
                      </td>
                      <td className="py-2 pr-2">{fmt(row.item.normalizedUnitPriceHt ?? row.item.rawUnitPriceHt)}</td>
                      <td className="py-2 pr-2">{fmt(row.item.rawTotalHt)}</td>
                      <td className="py-2 pr-2">
                        <div className="flex gap-1">
                          {row.document.pdfFileName && (
                            <a
                              href={`/api/benchmarks/documents/${row.document.id}/pdf`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1 hover:bg-muted rounded"
                              title="View PDF"
                              data-testid={`link-pdf-${row.document.id}`}
                            >
                              <FileText className="w-3.5 h-3.5" />
                            </a>
                          )}
                          <button
                            onClick={() => setEditing(row)}
                            className="p-1 hover:bg-muted rounded"
                            title="Edit tags"
                            data-testid={`button-edit-tags-${row.item.id}`}
                          >
                            <TagIcon className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => {
                              if (confirm("Delete this benchmark item?")) deleteMutation.mutate(row.item.id);
                            }}
                            className="p-1 hover:bg-muted rounded text-destructive"
                            title="Delete"
                            data-testid={`button-delete-item-${row.item.id}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {(!data?.results || data.results.length === 0) && (
                    <tr><td colSpan={9} className="py-6 text-center text-muted-foreground">No matching items.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {editing && tags && (
        <EditTagsDialog row={editing} allTags={tags} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

export default function CostBenchmarks() {
  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "#0B2545" }}>Cost Benchmarks</h1>
          <p className="text-sm text-muted-foreground">
            Searchable library of construction cost line items extracted from quotation PDFs.
          </p>
        </div>
        <Tabs defaultValue="search">
          <TabsList>
            <TabsTrigger value="search" data-testid="tab-search">Search</TabsTrigger>
            <TabsTrigger value="upload" data-testid="tab-upload">Upload</TabsTrigger>
          </TabsList>
          <TabsContent value="search" className="pt-4">
            <SearchPanel />
          </TabsContent>
          <TabsContent value="upload" className="pt-4">
            <UploadPanel />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
