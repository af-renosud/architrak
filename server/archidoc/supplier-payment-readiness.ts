import { env } from "../env";

export const SUPPLIER_PAYMENT_READINESS_PATH =
  "/api/integrations/architrak/v1/supplier-payment-readiness";
export const DEFAULT_SUPPLIER_PAYMENT_PAGE_LIMIT = 200;
export const MAX_SUPPLIER_PAYMENT_PAGE_LIMIT = 500;
export const MAX_SUPPLIER_PAYMENT_SYNC_PAGES = 100;

export type PaymentSupplierPrimaryContact = {
  id: string;
  name: string;
  jobTitle: string | null;
  email: string | null;
  mobile: string | null;
};

export type PaymentSupplierRibDocument = {
  id: string;
  fileName: string;
  mimeType: "application/pdf";
  sha256: string;
  downloadPath: string;
  updatedAt: string;
};

export type PaymentSupplierBanking = {
  accountHolderName: string | null;
  iban: string | null;
  bic: string | null;
  bankName: string | null;
  bankingVerificationStatus: "unverified" | "verified" | "rejected";
  bankingVerifiedAt: string | null;
  bankingVerifiedBy: { id: string; displayName: string } | null;
  bankingVerificationMethod: string | null;
  ribDocument: PaymentSupplierRibDocument | null;
};

export type PaymentSupplierAssignment = {
  id: string;
  projectId: string;
  directPaymentStatus: "eligible" | "not_eligible" | "suspended";
  validFrom: string | null;
  validUntil: string | null;
  reason: string | null;
  updatedAt: string;
};

export type PaymentSupplier = {
  id: string;
  partnerType: "supplier";
  name: string;
  siret: string | null;
  address1: string | null;
  address2: string | null;
  town: string | null;
  postcode: string | null;
  countryCode: string | null;
  isActive: boolean;
  primaryContact: PaymentSupplierPrimaryContact | null;
  banking: PaymentSupplierBanking | null;
  projectPaymentAssignments: PaymentSupplierAssignment[];
  updatedAt: string;
};

export type SupplierChange =
  | { sequence: bigint; operation: "upsert"; changedAt: string; supplier: PaymentSupplier }
  | { sequence: bigint; operation: "delete"; changedAt: string; supplierId: string };

export type SupplierWindow = {
  contractVersion: "supplier-payment-readiness.v1";
  syncWindow: {
    mode: "bootstrap" | "incremental";
    afterSequenceExclusive: bigint | null;
    throughSequenceInclusive: bigint;
    minimumAvailableSequence: bigint;
  };
  nextPageToken: string | null;
  changes: SupplierChange[];
};

export class PaymentSupplierReadinessValidationError extends Error {
  constructor(message: string) {
    super(`PaymentSupplierReadinessValidationError: ${message}`);
    this.name = "PaymentSupplierReadinessValidationError";
  }
}

export class PaymentSupplierCursorExpiredError extends Error {
  constructor(public readonly minimumAvailableSequence: bigint) {
    super("ArchiDoc supplier readiness cursor expired; bootstrap sync required");
    this.name = "PaymentSupplierCursorExpiredError";
  }
}

export function isValidIban(value: string): boolean {
  if (value !== value.toUpperCase() || /\s/.test(value) || !/^[A-Z0-9]{15,34}$/.test(value)) return false;
  const reordered = `${value.slice(4)}${value.slice(0, 4)}`;
  let remainder = 0;
  for (const character of reordered) {
    const digits = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function isValidBic(value: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PaymentSupplierReadinessValidationError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  const missing = keys.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (missing.length || unknown.length) {
    throw new PaymentSupplierReadinessValidationError(
      `${path} keys invalid` +
      (missing.length ? `; missing: ${missing.join(", ")}` : "") +
      (unknown.length ? `; unknown: ${unknown.join(", ")}` : ""),
    );
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PaymentSupplierReadinessValidationError(`${path} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function sequence(value: unknown, path: string): bigint {
  const wire = string(value, path);
  if (!/^(?:0|[1-9]\d*)$/.test(wire)) {
    throw new PaymentSupplierReadinessValidationError(`${path} must be an unsigned base-10 integer string`);
  }
  return BigInt(wire);
}

function timestamp(value: unknown, path: string): string {
  const wire = string(value, path);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(wire) || Number.isNaN(Date.parse(wire))) {
    throw new PaymentSupplierReadinessValidationError(`${path} must be a valid UTC ISO-8601 timestamp`);
  }
  return wire;
}

function localDate(value: unknown, path: string): string | null {
  if (value === null) return null;
  const wire = string(value, path);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(wire);
  if (!match || new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])).toISOString().slice(0, 10) !== wire) {
    throw new PaymentSupplierReadinessValidationError(`${path} must be a valid YYYY-MM-DD date`);
  }
  return wire;
}

function parseSupplier(value: unknown, path: string): PaymentSupplier {
  const supplier = record(value, path);
  exactKeys(supplier, [
    "id", "partnerType", "name", "siret", "address1", "address2", "town", "postcode",
    "countryCode", "isActive", "primaryContact", "banking", "projectPaymentAssignments", "updatedAt",
  ], path);
  if (supplier.partnerType !== "supplier") {
    throw new PaymentSupplierReadinessValidationError(`${path}.partnerType must be supplier`);
  }
  if (typeof supplier.isActive !== "boolean") {
    throw new PaymentSupplierReadinessValidationError(`${path}.isActive must be boolean`);
  }
  const siret = nullableString(supplier.siret, `${path}.siret`);
  if (siret !== null && !/^\d{14}$/.test(siret)) {
    throw new PaymentSupplierReadinessValidationError(`${path}.siret must contain exactly 14 digits`);
  }

  let primaryContact: PaymentSupplierPrimaryContact | null = null;
  if (supplier.primaryContact !== null) {
    const contact = record(supplier.primaryContact, `${path}.primaryContact`);
    exactKeys(contact, ["id", "name", "jobTitle", "email", "mobile"], `${path}.primaryContact`);
    primaryContact = {
      id: string(contact.id, `${path}.primaryContact.id`),
      name: string(contact.name, `${path}.primaryContact.name`),
      jobTitle: nullableString(contact.jobTitle, `${path}.primaryContact.jobTitle`),
      email: nullableString(contact.email, `${path}.primaryContact.email`),
      mobile: nullableString(contact.mobile, `${path}.primaryContact.mobile`),
    };
  }

  let banking: PaymentSupplierBanking | null = null;
  if (supplier.banking !== null) {
    const bank = record(supplier.banking, `${path}.banking`);
    exactKeys(bank, [
      "accountHolderName", "iban", "bic", "bankName", "bankingVerificationStatus",
      "bankingVerifiedAt", "bankingVerifiedBy", "bankingVerificationMethod", "ribDocument",
    ], `${path}.banking`);
    if (bank.bankingVerificationStatus !== "unverified" &&
        bank.bankingVerificationStatus !== "verified" &&
        bank.bankingVerificationStatus !== "rejected") {
      throw new PaymentSupplierReadinessValidationError(`${path}.banking.bankingVerificationStatus invalid`);
    }
    let verifiedBy: { id: string; displayName: string } | null = null;
    if (bank.bankingVerifiedBy !== null) {
      const by = record(bank.bankingVerifiedBy, `${path}.banking.bankingVerifiedBy`);
      exactKeys(by, ["id", "displayName"], `${path}.banking.bankingVerifiedBy`);
      verifiedBy = {
        id: string(by.id, `${path}.banking.bankingVerifiedBy.id`),
        displayName: string(by.displayName, `${path}.banking.bankingVerifiedBy.displayName`),
      };
    }
    const supplierId = string(supplier.id, `${path}.id`);
    const accountHolderName = nullableString(bank.accountHolderName, `${path}.banking.accountHolderName`);
    const iban = nullableString(bank.iban, `${path}.banking.iban`);
    const bic = nullableString(bank.bic, `${path}.banking.bic`);
    if (iban !== null && !isValidIban(iban)) {
      throw new PaymentSupplierReadinessValidationError(`${path}.banking.iban invalid`);
    }
    if (bic !== null && !isValidBic(bic)) {
      throw new PaymentSupplierReadinessValidationError(`${path}.banking.bic invalid`);
    }
    const method = nullableString(bank.bankingVerificationMethod, `${path}.banking.bankingVerificationMethod`);
    if (method !== null && !["manual_rib_review", "bank_account_check", "imported_verified"].includes(method)) {
      throw new PaymentSupplierReadinessValidationError(`${path}.banking.bankingVerificationMethod invalid`);
    }
    let ribDocument: PaymentSupplierRibDocument | null = null;
    if (bank.ribDocument !== null) {
      const rib = record(bank.ribDocument, `${path}.banking.ribDocument`);
      exactKeys(rib, ["id", "fileName", "mimeType", "sha256", "downloadPath", "updatedAt"], `${path}.banking.ribDocument`);
      if (rib.mimeType !== "application/pdf") {
        throw new PaymentSupplierReadinessValidationError(`${path}.banking.ribDocument.mimeType must be application/pdf`);
      }
      const sha256 = string(rib.sha256, `${path}.banking.ribDocument.sha256`);
      if (!/^[a-f0-9]{64}$/.test(sha256)) {
        throw new PaymentSupplierReadinessValidationError(`${path}.banking.ribDocument.sha256 invalid`);
      }
      const downloadPath = string(rib.downloadPath, `${path}.banking.ribDocument.downloadPath`);
      const ribId = string(rib.id, `${path}.banking.ribDocument.id`);
      const expectedPath = `/api/integrations/architrak/v1/suppliers/${encodeURIComponent(supplierId)}/rib/${encodeURIComponent(ribId)}`;
      if (downloadPath !== expectedPath) {
        throw new PaymentSupplierReadinessValidationError(`${path}.banking.ribDocument.downloadPath is not the bound protected RIB path`);
      }
      ribDocument = {
        id: ribId,
        fileName: string(rib.fileName, `${path}.banking.ribDocument.fileName`),
        mimeType: "application/pdf",
        sha256,
        downloadPath,
        updatedAt: timestamp(rib.updatedAt, `${path}.banking.ribDocument.updatedAt`),
      };
    }
    const bankingVerifiedAt = bank.bankingVerifiedAt === null ? null : timestamp(bank.bankingVerifiedAt, `${path}.banking.bankingVerifiedAt`);
    if (bank.bankingVerificationStatus === "verified" &&
        (!accountHolderName || !iban || !bankingVerifiedAt || !verifiedBy || !method || !ribDocument)) {
      throw new PaymentSupplierReadinessValidationError(`${path}.banking.verified requires account holder, valid IBAN, audit, method and RIB`);
    }
    banking = {
      accountHolderName,
      iban,
      bic,
      bankName: nullableString(bank.bankName, `${path}.banking.bankName`),
      bankingVerificationStatus: bank.bankingVerificationStatus,
      bankingVerifiedAt,
      bankingVerifiedBy: verifiedBy,
      bankingVerificationMethod: method,
      ribDocument,
    };
  }

  if (!Array.isArray(supplier.projectPaymentAssignments)) {
    throw new PaymentSupplierReadinessValidationError(`${path}.projectPaymentAssignments must be an array`);
  }
  const assignmentIds = new Set<string>();
  const assignments = supplier.projectPaymentAssignments.map((value, index): PaymentSupplierAssignment => {
    const assignmentPath = `${path}.projectPaymentAssignments[${index}]`;
    const assignment = record(value, assignmentPath);
    exactKeys(assignment, ["id", "projectId", "directPaymentStatus", "validFrom", "validUntil", "reason", "updatedAt"], assignmentPath);
    const id = string(assignment.id, `${assignmentPath}.id`);
    if (assignmentIds.has(id)) throw new PaymentSupplierReadinessValidationError(`${assignmentPath}.id is duplicated`);
    assignmentIds.add(id);
    if (assignment.directPaymentStatus !== "eligible" &&
        assignment.directPaymentStatus !== "not_eligible" &&
        assignment.directPaymentStatus !== "suspended") {
      throw new PaymentSupplierReadinessValidationError(`${assignmentPath}.directPaymentStatus invalid`);
    }
    return {
      id,
      projectId: string(assignment.projectId, `${assignmentPath}.projectId`),
      directPaymentStatus: assignment.directPaymentStatus,
      validFrom: localDate(assignment.validFrom, `${assignmentPath}.validFrom`),
      validUntil: localDate(assignment.validUntil, `${assignmentPath}.validUntil`),
      reason: nullableString(assignment.reason, `${assignmentPath}.reason`),
      updatedAt: timestamp(assignment.updatedAt, `${assignmentPath}.updatedAt`),
    };
  });

  return {
    id: string(supplier.id, `${path}.id`),
    partnerType: "supplier",
    name: string(supplier.name, `${path}.name`),
    siret,
    address1: nullableString(supplier.address1, `${path}.address1`),
    address2: nullableString(supplier.address2, `${path}.address2`),
    town: nullableString(supplier.town, `${path}.town`),
    postcode: nullableString(supplier.postcode, `${path}.postcode`),
    countryCode: nullableString(supplier.countryCode, `${path}.countryCode`),
    isActive: supplier.isActive,
    primaryContact,
    banking,
    projectPaymentAssignments: assignments,
    updatedAt: timestamp(supplier.updatedAt, `${path}.updatedAt`),
  };
}

export function parsePaymentSupplierWindow(raw: unknown): SupplierWindow {
  const root = record(raw, "response");
  exactKeys(root, ["contractVersion", "syncWindow", "nextPageToken", "changes"], "response");
  if (root.contractVersion !== "supplier-payment-readiness.v1") {
    throw new PaymentSupplierReadinessValidationError("response.contractVersion invalid");
  }
  const window = record(root.syncWindow, "response.syncWindow");
  exactKeys(window, ["mode", "afterSequenceExclusive", "throughSequenceInclusive", "minimumAvailableSequence"], "response.syncWindow");
  if (window.mode !== "bootstrap" && window.mode !== "incremental") {
    throw new PaymentSupplierReadinessValidationError("response.syncWindow.mode invalid");
  }
  const after = window.afterSequenceExclusive === null
    ? null
    : sequence(window.afterSequenceExclusive, "response.syncWindow.afterSequenceExclusive");
  const through = sequence(window.throughSequenceInclusive, "response.syncWindow.throughSequenceInclusive");
  const minimum = sequence(window.minimumAvailableSequence, "response.syncWindow.minimumAvailableSequence");
  if ((window.mode === "bootstrap") !== (after === null) || through < minimum || (after !== null && after > through)) {
    throw new PaymentSupplierReadinessValidationError("response.syncWindow is inconsistent");
  }
  const nextPageToken = root.nextPageToken === null
    ? null
    : string(root.nextPageToken, "response.nextPageToken");
  if (!Array.isArray(root.changes)) {
    throw new PaymentSupplierReadinessValidationError("response.changes must be an array");
  }
  let previous = after ?? BigInt(-1);
  const changes = root.changes.map((value, index): SupplierChange => {
    const path = `response.changes[${index}]`;
    const change = record(value, path);
    const operation = change.operation;
    if (operation === "upsert") {
      exactKeys(change, ["sequence", "operation", "changedAt", "supplier"], path);
    } else if (operation === "delete") {
      exactKeys(change, ["sequence", "operation", "changedAt", "supplierId"], path);
    } else {
      throw new PaymentSupplierReadinessValidationError(`${path}.operation invalid`);
    }
    const parsedSequence = sequence(change.sequence, `${path}.sequence`);
    if (parsedSequence <= previous || parsedSequence > through) {
      throw new PaymentSupplierReadinessValidationError(`${path}.sequence is out of order or outside the sync window`);
    }
    previous = parsedSequence;
    const changedAt = timestamp(change.changedAt, `${path}.changedAt`);
    return operation === "upsert"
      ? { sequence: parsedSequence, operation, changedAt, supplier: parseSupplier(change.supplier, `${path}.supplier`) }
      : { sequence: parsedSequence, operation, changedAt, supplierId: string(change.supplierId, `${path}.supplierId`) };
  });
  return {
    contractVersion: "supplier-payment-readiness.v1",
    syncWindow: {
      mode: window.mode,
      afterSequenceExclusive: after,
      throughSequenceInclusive: through,
      minimumAvailableSequence: minimum,
    },
    nextPageToken,
    changes,
  };
}

export type PaymentSupplierPageRequest =
  | { mode: "bootstrap"; limit?: number; afterSequence?: never; pageToken?: never }
  | { mode: "incremental"; afterSequence: bigint; limit?: number; pageToken?: never }
  | { pageToken: string; mode?: never; afterSequence?: never; limit?: never };

export type PaymentSupplierFetchOptions = {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
};

/** A continuation request intentionally contains only pageToken. */
export async function fetchPaymentSupplierWindow(
  request: PaymentSupplierPageRequest,
  options: PaymentSupplierFetchOptions = {},
): Promise<SupplierWindow> {
  const baseUrl = options.baseUrl ?? env.ARCHIDOC_BASE_URL;
  const apiKey = options.apiKey ?? env.ARCHIDOC_SYNC_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("ArchiDoc is not configured");
  const url = new URL(SUPPLIER_PAYMENT_READINESS_PATH, baseUrl);
  if ("pageToken" in request && request.pageToken !== undefined) {
    url.searchParams.set("pageToken", request.pageToken);
  } else {
    const limit = request.limit ?? DEFAULT_SUPPLIER_PAYMENT_PAGE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SUPPLIER_PAYMENT_PAGE_LIMIT) {
      throw new Error(`Supplier readiness limit must be an integer between 1 and ${MAX_SUPPLIER_PAYMENT_PAGE_LIMIT}`);
    }
    url.searchParams.set("mode", request.mode);
    if (request.mode === "incremental") url.searchParams.set("afterSequence", request.afterSequence.toString());
    url.searchParams.set("limit", String(limit));
  }
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!response.ok) {
    if (response.status === 410) {
      const body: unknown = await response.json().catch(() => null);
      try {
        const expired = record(body, "cursor expiry response");
        exactKeys(expired, ["code", "minimumAvailableSequence", "message"], "cursor expiry response");
        if (expired.code !== "SYNC_CURSOR_EXPIRED" ||
            expired.message !== "Run a bootstrap sync before resuming incrementally.") {
          throw new PaymentSupplierReadinessValidationError("cursor expiry response contract invalid");
        }
        throw new PaymentSupplierCursorExpiredError(
          sequence(expired.minimumAvailableSequence, "cursor expiry response.minimumAvailableSequence"),
        );
      } catch (error) {
        if (error instanceof PaymentSupplierCursorExpiredError) throw error;
        throw new PaymentSupplierReadinessValidationError("cursor expiry response contract invalid");
      }
    }
    const body = await response.text().catch(() => "");
    throw new Error(`ArchiDoc supplier readiness request failed (${response.status}): ${body}`);
  }
  return parsePaymentSupplierWindow(await response.json());
}

export type ProtectedRibFetchOptions = PaymentSupplierFetchOptions;

/** Fetches only the contract-bound private RIB path and verifies its bytes. */
export async function fetchProtectedPaymentSupplierRib(
  supplierId: string,
  rib: PaymentSupplierRibDocument,
  options: ProtectedRibFetchOptions = {},
): Promise<Buffer> {
  const baseUrl = options.baseUrl ?? env.ARCHIDOC_BASE_URL;
  const apiKey = options.apiKey ?? env.ARCHIDOC_SYNC_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("ArchiDoc is not configured");
  const expectedPath = `/api/integrations/architrak/v1/suppliers/${encodeURIComponent(supplierId)}/rib/${encodeURIComponent(rib.id)}`;
  if (rib.downloadPath !== expectedPath || !rib.downloadPath.startsWith("/") || rib.downloadPath.startsWith("//")) {
    throw new PaymentSupplierReadinessValidationError("RIB download path is not a bound relative path");
  }
  const base = new URL(baseUrl);
  const url = new URL(rib.downloadPath, base);
  if (url.origin !== base.origin) throw new PaymentSupplierReadinessValidationError("RIB download path crosses origin");
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-ArchiDoc-RIB-SHA256": rib.sha256,
    },
  });
  if (!response.ok) throw new Error(`ArchiDoc protected RIB request failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  if (actual !== rib.sha256) throw new PaymentSupplierReadinessValidationError("RIB bytes SHA-256 mismatch");
  return bytes;
}

function sameWindow(left: SupplierWindow, right: SupplierWindow): boolean {
  return left.syncWindow.mode === right.syncWindow.mode &&
    left.syncWindow.afterSequenceExclusive === right.syncWindow.afterSequenceExclusive &&
    left.syncWindow.throughSequenceInclusive === right.syncWindow.throughSequenceInclusive &&
    left.syncWindow.minimumAvailableSequence === right.syncWindow.minimumAvailableSequence;
}

export async function fetchAllPaymentSupplierWindows(
  initial: Exclude<PaymentSupplierPageRequest, { pageToken: string }>,
  fetchPage: (request: PaymentSupplierPageRequest) => Promise<SupplierWindow> = request => fetchPaymentSupplierWindow(request),
  maxPages = MAX_SUPPLIER_PAYMENT_SYNC_PAGES,
): Promise<SupplierWindow[]> {
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("maxPages must be a positive integer");
  const pages: SupplierWindow[] = [];
  const tokens = new Set<string>();
  let request: PaymentSupplierPageRequest = initial;
  let previousSequence: bigint | null = null;
  for (;;) {
    if (pages.length >= maxPages) throw new Error(`Supplier readiness exceeded maximum page count (${maxPages})`);
    const page = await fetchPage(request);
    const first = pages[0];
    if (!first) {
      const requestedAfter = initial.mode === "incremental" ? initial.afterSequence : null;
      if (page.syncWindow.mode !== initial.mode ||
          page.syncWindow.afterSequenceExclusive !== requestedAfter) {
        throw new Error("Supplier readiness first page does not match the requested sync window");
      }
    }
    if (first && !sameWindow(first, page)) throw new Error("Supplier readiness sync-window drift across pages");
    if (page.nextPageToken !== null && tokens.has(page.nextPageToken)) {
      throw new Error("Supplier readiness repeated page token");
    }
    for (const change of page.changes) {
      if (previousSequence !== null && change.sequence <= previousSequence) {
        throw new Error("Supplier readiness change sequence is not ordered across pages");
      }
      previousSequence = change.sequence;
    }
    pages.push(page);
    if (page.nextPageToken === null) return pages;
    tokens.add(page.nextPageToken);
    request = { pageToken: page.nextPageToken };
  }
}