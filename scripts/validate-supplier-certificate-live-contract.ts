import { createHash } from "crypto";
import { env } from "../server/env";
import {
  fetchSupplierPaymentReadinessPage,
  SupplierPaymentCursorExpiredError,
} from "../server/archidoc/sync-client";
import type {
  SupplierPaymentReadinessChange,
  SupplierPaymentReadinessResponse,
} from "../server/archidoc/supplier-payment-readiness-wire";

const hasStagingBaseUrl = !!env.ARCHIDOC_STAGING_BASE_URL;
const hasStagingApiKey = !!env.ARCHIDOC_STAGING_SYNC_API_KEY;
assert(
  hasStagingBaseUrl === hasStagingApiKey,
  "ARCHIDOC_STAGING_BASE_URL and ARCHIDOC_STAGING_SYNC_API_KEY must be configured together",
);
const validationBaseUrl =
  env.ARCHIDOC_STAGING_BASE_URL ?? env.ARCHIDOC_BASE_URL;
const validationApiKey =
  env.ARCHIDOC_STAGING_SYNC_API_KEY ?? env.ARCHIDOC_SYNC_API_KEY;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isPdf(buffer: Buffer): boolean {
  const headerOffset = buffer.indexOf(Buffer.from("%PDF-"));
  const tail = buffer
    .subarray(Math.max(0, buffer.length - 2048))
    .toString("latin1");
  return headerOffset >= 0 && headerOffset <= 1024 && tail.includes("%%EOF");
}

function stableResponse(response: SupplierPaymentReadinessResponse): string {
  return JSON.stringify(response);
}

async function directContractRequest(input: {
  authorization?: string;
  mode: "bootstrap" | "incremental";
  afterSequence?: string;
  limit?: number;
}): Promise<Response> {
  assert(validationBaseUrl, "No ArchiDoc validation base URL is configured");
  const url = new URL(
    "/api/integrations/architrak/v1/supplier-payment-readiness",
    validationBaseUrl,
  );
  url.searchParams.set("mode", input.mode);
  if (input.afterSequence !== undefined) {
    url.searchParams.set("afterSequence", input.afterSequence);
  }
  url.searchParams.set("limit", String(input.limit ?? 1));
  const headers: Record<string, string> = { Accept: "application/json" };
  if (input.authorization) headers.Authorization = input.authorization;
  return fetch(url, {
    method: "GET",
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
}

async function collectBootstrap(): Promise<{
  pages: number;
  changes: SupplierPaymentReadinessChange[];
  throughSequenceInclusive: string;
}> {
  let page = await fetchSupplierPaymentReadinessPage({
    mode: "bootstrap",
    limit: 200,
    connection: {
      baseUrl: validationBaseUrl!,
      apiKey: validationApiKey!,
    },
  });
  const throughSequenceInclusive =
    page.syncWindow.throughSequenceInclusive;
  const changes: SupplierPaymentReadinessChange[] = [];
  const tokens = new Set<string>();
  let pages = 0;

  while (true) {
    pages += 1;
    assert(
      pages <= 100,
      "Live bootstrap exceeded the 100-page validation safety limit",
    );
    assert(
      page.contractVersion === "supplier-payment-readiness.v1",
      "Live endpoint returned an unexpected supplier contract version",
    );
    assert(
      page.syncWindow.mode === "bootstrap",
      "Live bootstrap page changed sync mode",
    );
    assert(
      page.syncWindow.throughSequenceInclusive ===
        throughSequenceInclusive,
      "Live bootstrap page changed its frozen upper bound",
    );
    changes.push(...page.changes);
    if (!page.nextPageToken) break;
    assert(
      !tokens.has(page.nextPageToken),
      "Live bootstrap repeated an opaque page token",
    );
    tokens.add(page.nextPageToken);
    page = await fetchSupplierPaymentReadinessPage({
      pageToken: page.nextPageToken,
      connection: {
        baseUrl: validationBaseUrl!,
        apiKey: validationApiKey!,
      },
    });
  }

  return { pages, changes, throughSequenceInclusive };
}

async function validateProtectedRib(
  changes: SupplierPaymentReadinessChange[],
): Promise<"passed" | "no-current-rib-candidate"> {
  assert(validationBaseUrl, "No ArchiDoc validation base URL is configured");
  assert(validationApiKey, "No ArchiDoc validation credential is configured");
  const candidate = changes.find(
    (change) =>
      change.operation === "upsert" &&
      change.supplier.isActive &&
      change.supplier.banking?.bankingVerificationStatus === "verified" &&
      change.supplier.banking.ribDocument != null,
  );
  if (!candidate || candidate.operation !== "upsert") {
    return "no-current-rib-candidate";
  }
  const rib = candidate.supplier.banking?.ribDocument;
  assert(rib, "Selected live supplier has no protected RIB metadata");
  const url = new URL(rib.downloadPath, validationBaseUrl);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${validationApiKey}`,
      Accept: "application/pdf",
      "X-ArchiDoc-RIB-SHA256": rib.sha256,
    },
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.status === 200, "Protected live RIB did not return HTTP 200");
  const contentType =
    response.headers.get("content-type")?.split(";")[0].trim() ?? "";
  const cacheControl =
    response.headers.get("cache-control")?.toLowerCase() ?? "";
  const disposition =
    response.headers.get("content-disposition")?.toLowerCase() ?? "";
  const etag = response.headers.get("etag")?.toLowerCase() ?? "";
  assert(contentType === "application/pdf", "Protected live RIB is not PDF");
  assert(
    cacheControl.includes("private") && cacheControl.includes("no-store"),
    "Protected live RIB is missing private, no-store cache control",
  );
  assert(
    disposition.includes("attachment"),
    "Protected live RIB is missing attachment disposition",
  );
  assert(
    etag.includes(rib.sha256.toLowerCase()),
    "Protected live RIB ETag does not bind the declared hash",
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length > 0, "Protected live RIB returned no bytes");
  assert(isPdf(bytes), "Protected live RIB bytes are not a valid PDF envelope");
  assert(
    createHash("sha256").update(bytes).digest("hex") ===
      rib.sha256.toLowerCase(),
    "Protected live RIB bytes do not match the declared SHA-256",
  );

  const mismatchResponse = await fetch(url, {
    headers: {
      Authorization: `Bearer ${validationApiKey}`,
      Accept: "application/json",
      "X-ArchiDoc-RIB-SHA256": "0".repeat(64),
    },
    signal: AbortSignal.timeout(30_000),
  });
  assert(
    mismatchResponse.status === 409,
    "Protected live RIB hash mismatch did not return HTTP 409",
  );
  const mismatchBody = (await mismatchResponse.json()) as {
    code?: unknown;
  };
  assert(
    mismatchBody.code === "RIB_VERSION_MISMATCH",
    "Protected live RIB hash mismatch returned an unexpected body",
  );
  return "passed";
}

async function main() {
  assert(validationBaseUrl, "No ArchiDoc validation base URL is configured");
  assert(validationApiKey, "No ArchiDoc validation credential is configured");
  const connection = {
    baseUrl: validationBaseUrl,
    apiKey: validationApiKey,
  };

  const missingAuth = await directContractRequest({
    mode: "bootstrap",
    limit: 1,
  });
  const invalidAuth = await directContractRequest({
    mode: "bootstrap",
    limit: 1,
    authorization: "Bearer invalid-task-671-contract-probe",
  });
  const authorizationRejectionPassed =
    (missingAuth.status === 401 || missingAuth.status === 403) &&
    (invalidAuth.status === 401 || invalidAuth.status === 403);

  const bootstrap = await collectBootstrap();
  assert(
    authorizationRejectionPassed,
    `Supplier readiness authorization contract returned unexpected HTTP statuses (${missingAuth.status}/${invalidAuth.status})`,
  );
  const incrementalA = await fetchSupplierPaymentReadinessPage({
    mode: "incremental",
    afterSequence: bootstrap.throughSequenceInclusive,
    limit: 20,
    connection,
  });
  const incrementalB = await fetchSupplierPaymentReadinessPage({
    mode: "incremental",
    afterSequence: bootstrap.throughSequenceInclusive,
    limit: 20,
    connection,
  });
  assert(
    stableResponse(incrementalA) === stableResponse(incrementalB),
    "Replaying the same live incremental window was not idempotent",
  );

  let expiredCursorContract: "passed" | "history-retained";
  try {
    await fetchSupplierPaymentReadinessPage({
      mode: "incremental",
      afterSequence: "0",
      limit: 1,
      connection,
    });
    expiredCursorContract = "history-retained";
  } catch (error) {
    if (!(error instanceof SupplierPaymentCursorExpiredError)) throw error;
    assert(
      /^(0|[1-9]\d*)$/.test(error.minimumAvailableSequence),
      "Expired-cursor response returned an invalid minimum sequence",
    );
    expiredCursorContract = "passed";
  }

  const protectedRib = await validateProtectedRib(bootstrap.changes);
  const host = new URL(validationBaseUrl).hostname.toLowerCase();
  const environmentClassification =
    hasStagingBaseUrl
      ? "staging-override"
      : /(^|[.-])(staging|stage|test|sandbox|dev)([.-]|$)/.test(host)
      ? "staging-like"
      : "unclassified";

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        environmentClassification,
        contractVersion: "supplier-payment-readiness.v1",
        bootstrapPages: bootstrap.pages,
        bootstrapChanges: bootstrap.changes.length,
        authorizationRejection: "passed",
        incrementalReplay: "passed",
        expiredCursorContract,
        protectedRib,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        result: "FAIL",
        reason:
          error instanceof Error
            ? error.message
            : "Unknown live-contract validation failure",
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});