import { useQuery } from "@tanstack/react-query";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";

interface BurnUpPoint {
  date: string;
  contractValue: number | null;
  certifiedValue: number | null;
}

interface BurnUpData {
  contractValueHistory: Array<{ date: string; value: number }>;
  certifiedHistory: Array<{ date: string; value: number }>;
  currentContractValue: number;
  currentCertifiedTotal: number;
  percentComplete: number;
}

function formatEur(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "2-digit" });
}

function mergeSeries(data: BurnUpData): BurnUpPoint[] {
  const dateMap = new Map<string, BurnUpPoint>();

  for (const p of data.contractValueHistory) {
    if (!dateMap.has(p.date)) {
      dateMap.set(p.date, { date: p.date, contractValue: null, certifiedValue: null });
    }
    dateMap.get(p.date)!.contractValue = p.value;
  }

  for (const p of data.certifiedHistory) {
    if (!dateMap.has(p.date)) {
      dateMap.set(p.date, { date: p.date, contractValue: null, certifiedValue: null });
    }
    dateMap.get(p.date)!.certifiedValue = p.value;
  }

  const points = Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  let lastContract: number | null = null;
  let lastCert: number | null = null;
  for (const p of points) {
    if (p.contractValue !== null) lastContract = p.contractValue;
    else p.contractValue = lastContract;

    if (p.certifiedValue !== null) lastCert = p.certifiedValue;
    else p.certifiedValue = lastCert;
  }

  if (points.length > 0 && points[0].contractValue === null) {
    points[0].contractValue = data.currentContractValue;
  }

  return points;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: string;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-card border border-border rounded-md p-3 shadow-md" data-testid="tooltip-burnup">
      <p className="text-[11px] font-semibold text-foreground mb-1">{label ? formatDate(label) : ""}</p>
      {payload.map((entry, i) => (
        <p key={i} className="text-[11px] text-muted-foreground">
          <span style={{ color: entry.color }}>{entry.name}:</span>{" "}
          <span className="font-semibold text-foreground">{formatEur(entry.value)}</span>
        </p>
      ))}
    </div>
  );
}

export default function BurnUpChart({ projectId }: { projectId: number }) {
  const { data, isLoading } = useQuery<BurnUpData>({
    queryKey: ["/api/projects", projectId, "burn-up"],
    enabled: projectId > 0,
  });

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="skeleton-burnup">
        <Skeleton className="h-[300px] w-full rounded-lg" />
      </div>
    );
  }

  if (!data || (data.contractValueHistory.length === 0 && data.certifiedHistory.length === 0)) {
    return (
      <div className="flex items-center justify-center h-[300px] text-muted-foreground text-[12px]" data-testid="empty-burnup">
        No financial data available for this project yet.
      </div>
    );
  }

  const merged = mergeSeries(data);

  return (
    <div data-testid="chart-burnup">
      <div className="flex items-center gap-4 mb-3 flex-wrap">
        <div className="text-[11px] text-muted-foreground">
          Contract: <span className="font-semibold text-foreground" data-testid="text-contract-value">{formatEur(data.currentContractValue)}</span>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Certified: <span className="font-semibold text-foreground" data-testid="text-certified-value">{formatEur(data.currentCertifiedTotal)}</span>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Progress: <span className="font-semibold text-foreground" data-testid="text-percent-complete">{data.percentComplete}%</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={merged} margin={{ top: 5, right: 20, bottom: 5, left: 20 }}>
          <defs>
            <linearGradient id="contractFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#0B2545" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#0B2545" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="certifiedFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#c1a27b" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#c1a27b" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis
            dataKey="date"
            tickFormatter={formatDate}
            tick={{ fontSize: 10 }}
            className="text-muted-foreground"
          />
          <YAxis
            tickFormatter={(v: number) => formatEur(v)}
            tick={{ fontSize: 10 }}
            className="text-muted-foreground"
            width={90}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: "11px" }}
          />
          <Area
            type="stepAfter"
            dataKey="contractValue"
            name="Valeur Marche"
            stroke="#0B2545"
            strokeWidth={2}
            fill="url(#contractFill)"
            connectNulls
          />
          <Area
            type="monotone"
            dataKey="certifiedValue"
            name="Certifie Cumul"
            stroke="#c1a27b"
            strokeWidth={2}
            fill="url(#certifiedFill)"
            connectNulls
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
