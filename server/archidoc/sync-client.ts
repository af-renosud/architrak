import { env } from "../env";

const getBaseUrl = () => env.ARCHIDOC_BASE_URL;
const getApiKey = () => env.ARCHIDOC_SYNC_API_KEY;

export function isArchidocConfigured(): boolean {
  return !!(getBaseUrl() && getApiKey());
}

async function archidocFetch<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
  const baseUrl = getBaseUrl();
  const apiKey = getApiKey();

  if (!baseUrl || !apiKey) {
    throw new Error("ArchiDoc is not configured. Set ARCHIDOC_BASE_URL and ARCHIDOC_SYNC_API_KEY.");
  }

  const url = new URL(endpoint, baseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ArchiDoc API error ${response.status}: ${response.statusText}. ${body}`);
  }

  return response.json() as Promise<T>;
}

export interface ArchidocProjectData {
  id: string;
  projectName: string;
  code?: string;
  status?: string;
  siteAddress?: string;
  clients?: Array<{ name: string; email?: string; phone?: string; address?: string }>;
  customLots?: Array<{ lotNumber: string; descriptionFr: string; descriptionUk?: string }>;
  lotContractors?: Array<{ lotNumber: string; contractorId: string }>;
  actors?: Array<{ role: string; name: string; company?: string; siret?: string; address?: string }>;
  isDeleted?: boolean;
  updatedAt?: string;
}

export interface ArchidocContractorData {
  id: string;
  name: string;
  siret?: string;
  address1?: string;
  address2?: string;
  town?: string;
  postcode?: string;
  officePhone?: string;
  website?: string;
  tradeIds?: string[];
  insuranceStatus?: string;
  decennale?: {
    insurer?: string;
    policyNumber?: string;
    endDate?: string;
  };
  rcPro?: {
    insurer?: string;
    policyNumber?: string;
    endDate?: string;
  };
  specialConditions?: string;
  contacts?: Array<{
    name: string;
    jobTitle?: string;
    mobile?: string;
    email?: string;
    isPrimary?: boolean;
    notes?: string;
  }>;
  updatedAt?: string;
}

export interface ArchidocTradeData {
  id: string;
  label: string;
  description?: string;
  category?: string;
  sortOrder?: number;
}

export interface ArchidocProposalFeeData {
  id?: string;
  projectId: string;
  proServiceHt?: number;
  proServiceTva?: number;
  proServiceTtc?: number;
  planningHt?: number;
  planningTva?: number;
  planningTtc?: number;
  pmPercentage?: number;
  pmNote?: string;
  updatedAt?: string;
}

interface ProjectsResponse {
  projects: ArchidocProjectData[];
  syncTimestamp: string;
}

interface ContractorsResponse {
  contractors: ArchidocContractorData[];
  syncTimestamp: string;
}

interface TradesResponse {
  trades: ArchidocTradeData[];
  syncTimestamp: string;
}

interface ProposalFeesResponse {
  proposalFees: ArchidocProposalFeeData[];
  syncTimestamp: string;
}

export async function fetchProjects(since?: string): Promise<{ projects: ArchidocProjectData[]; syncTimestamp: string }> {
  const params: Record<string, string> = {};
  if (since) params.since = since;
  return archidocFetch<ProjectsResponse>("/api/sync/projects", params);
}

export async function fetchContractors(since?: string): Promise<{ contractors: ArchidocContractorData[]; syncTimestamp: string }> {
  const params: Record<string, string> = {};
  if (since) params.since = since;
  return archidocFetch<ContractorsResponse>("/api/sync/contractors", params);
}

export async function fetchTrades(): Promise<{ trades: ArchidocTradeData[]; syncTimestamp: string }> {
  return archidocFetch<TradesResponse>("/api/sync/trades");
}

export async function fetchProposalFees(projectId?: string): Promise<{ proposalFees: ArchidocProposalFeeData[]; syncTimestamp: string }> {
  const params: Record<string, string> = {};
  if (projectId) params.projectId = projectId;
  return archidocFetch<ProposalFeesResponse>("/api/sync/proposal-fees", params);
}

export async function checkConnection(): Promise<{ connected: boolean; error?: string }> {
  if (!isArchidocConfigured()) {
    return { connected: false, error: "ArchiDoc not configured (missing ARCHIDOC_BASE_URL or ARCHIDOC_SYNC_API_KEY)" };
  }
  try {
    await fetchProjects();
    return { connected: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { connected: false, error: message };
  }
}
