import { env } from "../env";
import {
  supplierPaymentCursorExpiredSchema,
  supplierPaymentReadinessResponseSchema,
  type SupplierPaymentReadinessMode,
  type SupplierPaymentReadinessResponse,
} from "./supplier-payment-readiness-wire";

const getBaseUrl = () => env.ARCHIDOC_BASE_URL;
const getApiKey = () => env.ARCHIDOC_SYNC_API_KEY;
const TECHNICAL_LOTS_ENDPOINT = "/api/integrations/architrak/technical-lots";

export function isArchidocConfigured(): boolean {
  return !!(getBaseUrl() && getApiKey());
}

export type ArchidocFetchErrorCode =
  | "not_configured"
  | "invalid_configuration"
  | "unauthorized"
  | "not_found"
  | "unavailable"
  | "http_error"
  | "timeout"
  | "network_error"
  | "invalid_response";

export interface ArchidocFetchDiagnostic {
  endpoint: string;
  outcome: "success" | "error";
  status: number | null;
  durationMs: number;
  checkedAt: string;
  code: ArchidocFetchErrorCode | null;
  reason: string;
}

export class ArchidocFetchError extends Error {
  constructor(public readonly diagnostic: ArchidocFetchDiagnostic) {
    const status = diagnostic.status == null ? "no HTTP response" : `HTTP ${diagnostic.status}`;
    super(`${diagnostic.code}: ${diagnostic.reason} (${status}, ${diagnostic.durationMs}ms)`);
    this.name = "ArchidocFetchError";
  }
}

interface ArchidocFetchOptions<T> {
  params?: Record<string, string>;
  connection?: {
    baseUrl: string;
    apiKey: string;
  };
  validate?: (raw: unknown) => T;
  successReason?: (value: T) => string;
  onDiagnostic?: (diagnostic: ArchidocFetchDiagnostic) => void;
  handleErrorResponse?: (
    response: Response,
  ) => Promise<Error | undefined>;
}

function safeHttpFailure(status: number): Pick<ArchidocFetchDiagnostic, "code" | "reason"> {
  if (status === 401) {
    return {
      code: "unauthorized",
      reason: "ArchiDoc rejected the configured sync credential.",
    };
  }
  if (status === 404) {
    return {
      code: "not_found",
      reason: "The configured ArchiDoc host does not expose the requested endpoint.",
    };
  }
  if (status === 503) {
    return {
      code: "unavailable",
      reason: "ArchiDoc is temporarily unavailable.",
    };
  }
  return {
    code: "http_error",
    reason: `ArchiDoc returned HTTP ${status}.`,
  };
}

function makeFetchDiagnostic(
  endpoint: string,
  startedAt: number,
  values: Pick<ArchidocFetchDiagnostic, "outcome" | "status" | "code" | "reason">,
): ArchidocFetchDiagnostic {
  return {
    endpoint,
    durationMs: Math.max(0, Date.now() - startedAt),
    checkedAt: new Date().toISOString(),
    ...values,
  };
}

async function archidocFetch<T>(
  endpoint: string,
  options: ArchidocFetchOptions<T> = {},
): Promise<T> {
  const startedAt = Date.now();
  const baseUrl = options.connection?.baseUrl ?? getBaseUrl();
  const apiKey = options.connection?.apiKey ?? getApiKey();

  if (!baseUrl || !apiKey) {
    const diagnostic = makeFetchDiagnostic(endpoint, startedAt, {
      outcome: "error",
      status: null,
      code: "not_configured",
      reason: "ArchiDoc sync is not configured.",
    });
    options.onDiagnostic?.(diagnostic);
    throw new ArchidocFetchError(diagnostic);
  }

  let url: URL;
  try {
    url = new URL(endpoint, baseUrl);
  } catch {
    const diagnostic = makeFetchDiagnostic(endpoint, startedAt, {
      outcome: "error",
      status: null,
      code: "invalid_configuration",
      reason: "The configured ArchiDoc base URL is invalid.",
    });
    options.onDiagnostic?.(diagnostic);
    throw new ArchidocFetchError(diagnostic);
  }
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url.searchParams.set(key, value);
    }
  }

  try {
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
      const handled = await options.handleErrorResponse?.(response);
      if (handled) throw handled;
      const failure = safeHttpFailure(response.status);
      const diagnostic = makeFetchDiagnostic(endpoint, startedAt, {
        outcome: "error",
        status: response.status,
        ...failure,
      });
      options.onDiagnostic?.(diagnostic);
      throw new ArchidocFetchError(diagnostic);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      const diagnostic = makeFetchDiagnostic(endpoint, startedAt, {
        outcome: "error",
        status: response.status,
        code: "invalid_response",
        reason: "ArchiDoc returned a response that was not valid JSON.",
      });
      options.onDiagnostic?.(diagnostic);
      throw new ArchidocFetchError(diagnostic);
    }

    let value: T;
    try {
      value = options.validate ? options.validate(raw) : raw as T;
    } catch (error) {
      if (error instanceof ArchidocFetchError) throw error;
      const diagnostic = makeFetchDiagnostic(endpoint, startedAt, {
        outcome: "error",
        status: response.status,
        code: "invalid_response",
        reason: "The ArchiDoc response failed contract validation.",
      });
      options.onDiagnostic?.(diagnostic);
      throw new ArchidocFetchError(diagnostic);
    }

    const diagnostic = makeFetchDiagnostic(endpoint, startedAt, {
      outcome: "success",
      status: response.status,
      code: null,
      reason: options.successReason?.(value) ?? "ArchiDoc response validated.",
    });
    options.onDiagnostic?.(diagnostic);
    return value;
  } catch (error) {
    if (
      error instanceof ArchidocFetchError ||
      (
        error instanceof Error &&
        error.name === "SupplierPaymentCursorExpiredError"
      )
    ) {
      throw error;
    }
    const timedOut =
      error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
    const diagnostic = makeFetchDiagnostic(endpoint, startedAt, {
      outcome: "error",
      status: null,
      code: timedOut ? "timeout" : "network_error",
      reason: timedOut
        ? "The ArchiDoc request timed out after 30 seconds."
        : "The ArchiDoc request failed before an HTTP response was received.",
    });
    options.onDiagnostic?.(diagnostic);
    throw new ArchidocFetchError(diagnostic);
  }
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
  partnerType?: "contractor" | "supplier";
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
  // Task #225 — Banking details fed from ArchiDoc. All optional: a
  // contractor on ArchiDoc may not yet have a verified RIB on file.
  //
  // Task #226 — Audit fields use the PREFIXED key names
  // (`bankingVerifiedAt`, `bankingVerifiedBy`, `bankingAiExtractedData`)
  // because that's what ArchiDoc's `/api/sync/contractors` actually
  // emits inside this nested block (they kept the prefix to mirror
  // their column names). The short forms were a silent data-dropper.
  banking?: {
    accountHolderName?: string;
    iban?: string;
    bic?: string;
    bankName?: string;
    ribDocumentUrl?: string;
    ribDocumentName?: string;
    bankingVerifiedAt?: string;
    bankingVerifiedBy?: string;
    bankingAiExtractedData?: unknown;
  };
  updatedAt?: string;
}

export interface ArchidocSupplierData {
  id: string;
  name: string;
  isActive?: boolean;
  contactName?: string;
  contact?: string;
  email?: string;
  contactEmail?: string;
  phone?: string;
  contactPhone?: string;
  website?: string;
  description?: string;
  notes?: string;
  specialty?: string;
  catalogUrl?: string;
  tags?: string[];
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
  return archidocFetch<ProjectsResponse>("/api/sync/projects", { params });
}

export async function fetchContractors(since?: string): Promise<{ contractors: ArchidocContractorData[]; syncTimestamp: string }> {
  const params: Record<string, string> = {};
  if (since) params.since = since;
  return archidocFetch<ContractorsResponse>("/api/sync/contractors", { params });
}

export async function fetchSuppliers(): Promise<ArchidocSupplierData[]> {
  return archidocFetch<ArchidocSupplierData[]>("/api/suppliers");
}

export class SupplierPaymentCursorExpiredError extends Error {
  constructor(public readonly minimumAvailableSequence: string) {
    super(
      `Supplier payment-readiness cursor expired; minimum available sequence is ${minimumAvailableSequence}.`,
    );
    this.name = "SupplierPaymentCursorExpiredError";
  }
}

export async function fetchSupplierPaymentReadinessPage(input: {
  mode?: SupplierPaymentReadinessMode;
  afterSequence?: string;
  pageToken?: string;
  limit?: number;
  connection?: {
    baseUrl: string;
    apiKey: string;
  };
}): Promise<SupplierPaymentReadinessResponse> {
  const params: Record<string, string> = {};
  if (input.pageToken) {
    params.pageToken = input.pageToken;
  } else {
    if (!input.mode) {
      throw new Error(
        "Supplier payment-readiness first page requires a sync mode.",
      );
    }
    params.mode = input.mode;
    if (input.afterSequence !== undefined) {
      params.afterSequence = input.afterSequence;
    }
    params.limit = String(input.limit ?? 200);
  }
  return archidocFetch<SupplierPaymentReadinessResponse>(
    "/api/integrations/architrak/v1/supplier-payment-readiness",
    {
      params,
      connection: input.connection,
      validate: (raw) => supplierPaymentReadinessResponseSchema.parse(raw),
      successReason: (value) =>
        `Validated ${value.changes.length} supplier payment-readiness change(s).`,
      handleErrorResponse: async (response) => {
        if (response.status !== 410) return undefined;
        let raw: unknown;
        try {
          raw = await response.json();
        } catch {
          return undefined;
        }
        const parsed = supplierPaymentCursorExpiredSchema.safeParse(raw);
        return parsed.success
          ? new SupplierPaymentCursorExpiredError(
              parsed.data.minimumAvailableSequence,
            )
          : undefined;
      },
    },
  );
}

export async function fetchTrades(): Promise<{ trades: ArchidocTradeData[]; syncTimestamp: string }> {
  return archidocFetch<TradesResponse>("/api/sync/trades");
}

export async function fetchProposalFees(projectId?: string): Promise<{ proposalFees: ArchidocProposalFeeData[]; syncTimestamp: string }> {
  const params: Record<string, string> = {};
  if (projectId) params.projectId = projectId;
  return archidocFetch<ProposalFeesResponse>("/api/sync/proposal-fees", { params });
}

// --- Technical-lot catalogue -------------------------------------------
//
// GET /api/integrations/architrak/technical-lots returns the FULL catalogue
// on every call (no delta / `since` parameter). The response carries all
// tombstoned rows too, so absence from the response is NOT a deletion signal
// — the service layer enforces this guarantee separately.

export interface ArchidocTechnicalLotItem {
  id: string;
  code: string;
  labelFr: string;
  displayOrder: number;
  isActive: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArchidocTechnicalLotCatalogue {
  revision: number;
  changedAt: string;
}

export interface ArchidocTechnicalLotsResponse {
  lots: ArchidocTechnicalLotItem[];
  catalogue: ArchidocTechnicalLotCatalogue;
}

// --- Runtime validation for the technical-lots endpoint ------------------
//
// Every field is validated strictly so malformed upstream data is caught
// before it reaches the DB. Any violation throws with a descriptive message.

function isIsoDate(s: string): boolean {
  // Require a complete ISO-8601 timestamp with an explicit timezone. Date.parse
  // alone accepts locale-like and normalized-invalid values, which is too
  // permissive for a mirror publication gate.
  if (typeof s !== "string" || s.trim() === "") return false;
  const match = s.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] == null ? 0 : Number(match[8]);
  const offsetMinute = match[9] == null ? 0 : Number(match[9]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > maxDay) return false;
  const d = new Date(s);
  return isFinite(d.getTime());
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const expectedSet = new Set(expected);
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  const unknown = Object.keys(value).filter((key) => !expectedSet.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new TechnicalLotsValidationError(
      `${path} has an unexpected shape` +
      (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
      (unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : ""),
    );
  }
}

export class TechnicalLotsValidationError extends Error {
  constructor(message: string) {
    super(`TechnicalLotsValidationError: ${message}`);
    this.name = "TechnicalLotsValidationError";
  }
}

export function validateTechnicalLotsResponse(raw: unknown): ArchidocTechnicalLotsResponse {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TechnicalLotsValidationError("Response root must be an object");
  }
  const obj = raw as Record<string, unknown>;
  assertExactKeys(obj, ["lots", "catalogue"], "response");

  // ---- catalogue ---------------------------------------------------------
  if (obj.catalogue === null || typeof obj.catalogue !== "object" || Array.isArray(obj.catalogue)) {
    throw new TechnicalLotsValidationError("catalogue must be an object");
  }
  const cat = obj.catalogue as Record<string, unknown>;
  assertExactKeys(cat, ["revision", "changedAt"], "catalogue");

  if (typeof cat.revision !== "number" || !Number.isInteger(cat.revision) || cat.revision < 0) {
    throw new TechnicalLotsValidationError(
      `catalogue.revision must be a non-negative integer, got ${JSON.stringify(cat.revision)}`,
    );
  }
  if (!isIsoDate(cat.changedAt as string)) {
    throw new TechnicalLotsValidationError(
      `catalogue.changedAt must be a valid ISO-8601 date string, got ${JSON.stringify(cat.changedAt)}`,
    );
  }

  // ---- lots --------------------------------------------------------------
  if (!Array.isArray(obj.lots)) {
    throw new TechnicalLotsValidationError("lots must be an array");
  }

  const seenIds = new Set<string>();
  const seenCodes = new Set<string>();

  const lots: ArchidocTechnicalLotItem[] = [];
  for (let i = 0; i < obj.lots.length; i++) {
    const raw = obj.lots[i];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TechnicalLotsValidationError(`lots[${i}] must be an object`);
    }
    const lot = raw as Record<string, unknown>;
    assertExactKeys(
      lot,
      ["id", "code", "labelFr", "displayOrder", "isActive", "deletedAt", "createdAt", "updatedAt"],
      `lots[${i}]`,
    );

    // id
    if (typeof lot.id !== "string" || lot.id.trim() === "" || lot.id.length > 255) {
      throw new TechnicalLotsValidationError(`lots[${i}].id must be a non-blank string of at most 255 characters, got ${JSON.stringify(lot.id)}`);
    }
    if (seenIds.has(lot.id)) {
      throw new TechnicalLotsValidationError(`lots[${i}].id "${lot.id}" is a duplicate`);
    }
    seenIds.add(lot.id);

    // code
    if (typeof lot.code !== "string" || lot.code.trim() === "") {
      throw new TechnicalLotsValidationError(`lots[${i}].code must be a non-blank string, got ${JSON.stringify(lot.code)}`);
    }
    if (seenCodes.has(lot.code)) {
      throw new TechnicalLotsValidationError(`lots[${i}].code "${lot.code}" is a duplicate`);
    }
    seenCodes.add(lot.code);

    // labelFr
    if (typeof lot.labelFr !== "string" || lot.labelFr.trim() === "") {
      throw new TechnicalLotsValidationError(`lots[${i}].labelFr must be a non-blank string, got ${JSON.stringify(lot.labelFr)}`);
    }

    // displayOrder
    if (typeof lot.displayOrder !== "number" || !Number.isInteger(lot.displayOrder) || lot.displayOrder < 0) {
      throw new TechnicalLotsValidationError(
        `lots[${i}].displayOrder must be a non-negative integer, got ${JSON.stringify(lot.displayOrder)}`,
      );
    }

    // isActive
    if (typeof lot.isActive !== "boolean") {
      throw new TechnicalLotsValidationError(`lots[${i}].isActive must be a boolean, got ${JSON.stringify(lot.isActive)}`);
    }

    // deletedAt — null or valid ISO date
    if (lot.deletedAt !== null) {
      if (typeof lot.deletedAt !== "string") {
        throw new TechnicalLotsValidationError(
          `lots[${i}].deletedAt must be null or a valid ISO-8601 date string, got ${JSON.stringify(lot.deletedAt)}`,
        );
      }
      if (!isIsoDate(lot.deletedAt as string)) {
        throw new TechnicalLotsValidationError(
          `lots[${i}].deletedAt must be null or a valid ISO-8601 date string, got ${JSON.stringify(lot.deletedAt)}`,
        );
      }
      // Contradiction: a lot that is isActive=true must not have a deletedAt
      if (lot.isActive === true) {
        throw new TechnicalLotsValidationError(
          `lots[${i}] id="${lot.id}": isActive=true but deletedAt is set (${JSON.stringify(lot.deletedAt)}); contradiction`,
        );
      }
    }

    // createdAt
    if (!isIsoDate(lot.createdAt as string)) {
      throw new TechnicalLotsValidationError(
        `lots[${i}].createdAt must be a valid ISO-8601 date string, got ${JSON.stringify(lot.createdAt)}`,
      );
    }

    // updatedAt
    if (!isIsoDate(lot.updatedAt as string)) {
      throw new TechnicalLotsValidationError(
        `lots[${i}].updatedAt must be a valid ISO-8601 date string, got ${JSON.stringify(lot.updatedAt)}`,
      );
    }

    lots.push({
      id: lot.id,
      code: lot.code,
      labelFr: lot.labelFr,
      displayOrder: lot.displayOrder,
      isActive: lot.isActive,
      deletedAt: lot.deletedAt as string | null,
      createdAt: lot.createdAt as string,
      updatedAt: lot.updatedAt as string,
    });
  }

  return {
    lots,
    catalogue: {
      revision: cat.revision as number,
      changedAt: cat.changedAt as string,
    },
  };
}

let lastTechnicalLotsFetchDiagnostic: ArchidocFetchDiagnostic | null = null;

function recordTechnicalLotsFetchDiagnostic(diagnostic: ArchidocFetchDiagnostic): void {
  lastTechnicalLotsFetchDiagnostic = diagnostic;
  const safeRecord = {
    endpoint: diagnostic.endpoint,
    outcome: diagnostic.outcome,
    status: diagnostic.status,
    durationMs: diagnostic.durationMs,
    code: diagnostic.code,
    reason: diagnostic.reason,
  };
  if (diagnostic.outcome === "success") {
    console.info("[ArchiDoc Technical Lots] Fetch completed", safeRecord);
  } else {
    console.warn("[ArchiDoc Technical Lots] Fetch failed", safeRecord);
  }
}

export function getLastTechnicalLotsFetchDiagnostic(): ArchidocFetchDiagnostic | null {
  return lastTechnicalLotsFetchDiagnostic ? { ...lastTechnicalLotsFetchDiagnostic } : null;
}

export async function fetchTechnicalLots(): Promise<ArchidocTechnicalLotsResponse> {
  return archidocFetch<ArchidocTechnicalLotsResponse>(TECHNICAL_LOTS_ENDPOINT, {
    validate: validateTechnicalLotsResponse,
    successReason: (response) => `Validated ${response.lots.length} technical-lot records.`,
    onDiagnostic: recordTechnicalLotsFetchDiagnostic,
  });
}

// --- Cached, non-blocking connectivity status ---------------------------
//
// The status endpoint used to call checkConnection() synchronously, which
// performs a real upstream fetch with a 30s timeout — so a slow/unreachable
// ArchiDoc backend froze the Projects page and the New Project dialog for up
// to 30 seconds. We now cache the last connectivity verdict and refresh it in
// the background; callers wait at most CONNECTION_PROBE_WAIT_MS for a fresh
// answer before falling back to the cached (or "pending") verdict.
const CONNECTION_CACHE_TTL_MS = 60_000;
const CONNECTION_PROBE_WAIT_MS = 2_500;

interface ConnectionVerdict {
  connected: boolean;
  error?: string;
  checkedAt: string;
}

let cachedConnection: ConnectionVerdict | null = null;
let connectionProbeInFlight: Promise<ConnectionVerdict> | null = null;

function probeConnection(): Promise<ConnectionVerdict> {
  if (!connectionProbeInFlight) {
    connectionProbeInFlight = checkConnection()
      .then((result) => {
        const verdict: ConnectionVerdict = { ...result, checkedAt: new Date().toISOString() };
        cachedConnection = verdict;
        return verdict;
      })
      .finally(() => {
        connectionProbeInFlight = null;
      });
  }
  return connectionProbeInFlight;
}

/**
 * Non-blocking connectivity status. Returns quickly (bounded by
 * CONNECTION_PROBE_WAIT_MS), preferring a fresh cached verdict; when the
 * cache is stale it kicks off a background probe and returns the stale
 * verdict (flagged `stale: true`) or a "check in progress" placeholder.
 */
export async function getConnectionStatus(): Promise<ConnectionVerdict & { stale?: boolean; pending?: boolean }> {
  if (!isArchidocConfigured()) {
    return {
      connected: false,
      error: "ArchiDoc not configured (missing ARCHIDOC_BASE_URL or ARCHIDOC_SYNC_API_KEY)",
      checkedAt: new Date().toISOString(),
    };
  }

  const fresh =
    cachedConnection &&
    Date.now() - new Date(cachedConnection.checkedAt).getTime() < CONNECTION_CACHE_TTL_MS;
  if (fresh && cachedConnection) return cachedConnection;

  const probe = probeConnection();
  const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), CONNECTION_PROBE_WAIT_MS));
  const result = await Promise.race([probe, timer]);
  if (result) return result;

  if (cachedConnection) return { ...cachedConnection, stale: true };
  return {
    connected: false,
    error: "Connectivity check in progress",
    checkedAt: new Date().toISOString(),
    pending: true,
  };
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
