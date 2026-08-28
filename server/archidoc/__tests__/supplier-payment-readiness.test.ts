import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  fetchAllPaymentSupplierWindows,
  fetchPaymentSupplierWindow,
  fetchProtectedPaymentSupplierRib,
  isValidBic,
  isValidIban,
  PaymentSupplierCursorExpiredError,
  parsePaymentSupplierWindow,
  type PaymentSupplierPageRequest,
  type SupplierWindow,
} from "../supplier-payment-readiness";
import {
  applyPaymentSupplierWindows,
  syncPaymentSupplierReadiness,
  type PaymentSupplierMirrorStore,
  type PaymentSupplierMirrorTransaction,
} from "../payment-supplier-mirror-service";

const fixturePath = fileURLToPath(new URL("./fixtures/supplier-payment-readiness-v1.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

function clone<T>(value: T): T {
  return structuredClone(value);
}

function page(overrides: {
  after?: string;
  through?: string;
  next?: string | null;
  sequence?: string;
  operation?: "upsert" | "delete";
} = {}): unknown {
  const value = clone(fixture);
  value.syncWindow.afterSequenceExclusive = overrides.after ?? "8420";
  value.syncWindow.throughSequenceInclusive = overrides.through ?? "8421";
  value.nextPageToken = overrides.next ?? null;
  value.changes[0].sequence = overrides.sequence ?? "8421";
  if (overrides.operation === "delete") {
    value.changes[0] = {
      sequence: overrides.sequence ?? "8421",
      operation: "delete",
      changedAt: "2026-08-24T09:13:00Z",
      supplierId: "supplier_deleted",
    };
  }
  return value;
}

class MemoryStore implements PaymentSupplierMirrorStore {
  sequence = BigInt(0);
  rows = new Map<string, { sequence: bigint; body: string; deleted: boolean; assignments: string[] }>();

  async transaction<T>(operation: (tx: PaymentSupplierMirrorTransaction) => Promise<T>): Promise<T> {
    const oldSequence = this.sequence;
    const oldRows = structuredClone(this.rows);
    const tx: PaymentSupplierMirrorTransaction = {
      currentSequence: async () => this.sequence,
      applyChange: async change => {
        const id = change.operation === "upsert" ? change.supplier.id : change.supplierId;
        const body = JSON.stringify(change, (_, value) => typeof value === "bigint" ? value.toString() : value);
        const existing = this.rows.get(id);
        if (existing && existing.sequence >= change.sequence) {
          if (existing.sequence === change.sequence && existing.body === body) return "duplicate";
          throw new Error("conflicting old sequence");
        }
        this.rows.set(id, {
          sequence: change.sequence,
          body,
          deleted: change.operation === "delete",
          assignments: change.operation === "upsert"
            ? change.supplier.projectPaymentAssignments.map(assignment => assignment.id)
            : [],
        });
        return "applied";
      },
      reconcileBootstrap: async (seen, through) => {
        for (const [id, row] of this.rows) {
          if (!seen.includes(id)) this.rows.set(id, { ...row, deleted: true, sequence: through });
        }
      },
      advanceSequence: async (_stream, expected, next) => {
        if (this.sequence !== expected) throw new Error("concurrent sequence");
        this.sequence = next;
      },
    };
    try {
      return await operation(tx);
    } catch (error) {
      this.sequence = oldSequence;
      this.rows = oldRows;
      throw error;
    }
  }
}

describe("supplier-payment-readiness.v1 parser", () => {
  it("parses the exact copied ArchiDoc fixture", () => {
    const parsed = parsePaymentSupplierWindow(fixture);
    expect(parsed.contractVersion).toBe("supplier-payment-readiness.v1");
    expect(parsed.changes[0].sequence).toBe(BigInt(8421));
    expect(parsed.changes[0].operation === "upsert" && parsed.changes[0].supplier.banking?.ribDocument?.downloadPath)
      .toMatch(/^\/api\/integrations\/architrak\//);
  });

  it("keeps sequences above MAX_SAFE_INTEGER as bigint and accepts non-contiguous events", () => {
    const value = clone(fixture);
    value.syncWindow.afterSequenceExclusive = "9007199254740993";
    value.syncWindow.throughSequenceInclusive = "9007199254741009";
    value.changes[0].sequence = "9007199254741001";
    value.changes.push({
      sequence: "9007199254741009",
      operation: "delete",
      changedAt: "2026-08-24T09:13:00Z",
      supplierId: "supplier_old",
    });
    const parsed = parsePaymentSupplierWindow(value);
    expect(parsed.changes.map(change => change.sequence)).toEqual([
      BigInt("9007199254741001"),
      BigInt("9007199254741009"),
    ]);
  });

  it("rejects unknown keys", () => {
    expect(() => parsePaymentSupplierWindow({ ...fixture, unexpected: true })).toThrow(/keys invalid/);
  });

  it("strictly validates banking audit fields, IBAN/BIC and bound RIB paths", () => {
    expect(isValidIban("FR7630006000011234567890189")).toBe(true);
    expect(isValidIban("FR7630006000011234567890188")).toBe(false);
    expect(isValidBic("AGRIFRPPXXX")).toBe(true);
    expect(isValidBic("agriFRPP")).toBe(false);
    const invalidMethod = clone(fixture);
    invalidMethod.changes[0].supplier.banking.bankingVerificationMethod = "email";
    expect(() => parsePaymentSupplierWindow(invalidMethod)).toThrow(/VerificationMethod invalid/);
    const incompleteVerified = clone(fixture);
    incompleteVerified.changes[0].supplier.banking.ribDocument = null;
    expect(() => parsePaymentSupplierWindow(incompleteVerified)).toThrow(/verified requires/);
    const pathSwap = clone(fixture);
    pathSwap.changes[0].supplier.banking.ribDocument.downloadPath = "/api/integrations/architrak/v1/suppliers/other/rib/rib_01J6ARCHITRAK0000000000001";
    expect(() => parsePaymentSupplierWindow(pathSwap)).toThrow(/bound protected RIB path/);
  });
});

describe("supplier payment pagination", () => {
  it("uses mode, afterSequence and limit first, then only pageToken", async () => {
    const responses = [
      page({ through: "8422", next: "opaque-next", sequence: "8421" }),
      page({ through: "8422", sequence: "8422", operation: "delete" }),
    ];
    const urls: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const fetchPage = (request: PaymentSupplierPageRequest) => fetchPaymentSupplierWindow(request, {
      baseUrl: "https://archidoc.example",
      apiKey: "secret",
      fetchImpl,
    });
    const pages = await fetchAllPaymentSupplierWindows({
      mode: "incremental",
      afterSequence: BigInt(8420),
      limit: 50,
    }, fetchPage);
    expect(pages).toHaveLength(2);
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({
      mode: "incremental",
      afterSequence: "8420",
      limit: "50",
    });
    expect(Object.fromEntries(urls[1].searchParams)).toEqual({ pageToken: "opaque-next" });
  });

  it("uses the frozen default limit and rejects values outside 1..500", async () => {
    const urls: URL[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify(page()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const options = {
      baseUrl: "https://archidoc.example",
      apiKey: "secret",
      fetchImpl,
    };
    await fetchPaymentSupplierWindow(
      { mode: "incremental", afterSequence: BigInt(8420) },
      options,
    );
    expect(urls[0].searchParams.get("limit")).toBe("200");
    for (const limit of [0, 501, 1.5]) {
      await expect(fetchPaymentSupplierWindow(
        { mode: "incremental", afterSequence: BigInt(8420), limit },
        options,
      )).rejects.toThrow(/integer between 1 and 500/);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects repeated tokens, drift, and excessive pages", async () => {
    const repeated = parsePaymentSupplierWindow(page({ next: "same" }));
    await expect(fetchAllPaymentSupplierWindows(
      { mode: "incremental", afterSequence: BigInt(8420) },
      async () => repeated,
    )).rejects.toThrow(/repeated page token/);

    const stable = parsePaymentSupplierWindow(page({ through: "8422", next: "next" }));
    const drifted = parsePaymentSupplierWindow(page({ after: "8419", through: "8422", sequence: "8421" }));
    let calls = 0;
    await expect(fetchAllPaymentSupplierWindows(
      { mode: "incremental", afterSequence: BigInt(8420) },
      async () => calls++ === 0 ? stable : drifted,
    )).rejects.toThrow(/drift across pages/);

    await expect(fetchAllPaymentSupplierWindows(
      { mode: "incremental", afterSequence: BigInt(8420) },
      async () => stable,
      1,
    )).rejects.toThrow(/maximum page count/);
  });

  it("turns only the exact cursor-expiry 410 contract into a typed error", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: "SYNC_CURSOR_EXPIRED",
      minimumAvailableSequence: "8000",
      message: "Run a bootstrap sync before resuming incrementally.",
    }), { status: 410 }));
    await expect(fetchPaymentSupplierWindow({ mode: "incremental", afterSequence: BigInt(7) }, {
      baseUrl: "https://archidoc.example", apiKey: "secret", fetchImpl,
    })).rejects.toBeInstanceOf(PaymentSupplierCursorExpiredError);
  });
});

describe("supplier payment atomic apply", () => {
  it("recovers with a bootstrap snapshot from an arbitrary durable high-water", async () => {
    const store = new MemoryStore();
    store.sequence = BigInt(7000);
    const bootstrap = clone(fixture);
    bootstrap.syncWindow.mode = "bootstrap";
    bootstrap.syncWindow.afterSequenceExclusive = null;
    await expect(applyPaymentSupplierWindows(store, [parsePaymentSupplierWindow(bootstrap)]))
      .resolves.toBe(1);
    expect(store.sequence).toBe(BigInt(8421));
  });

  it("replays an exact batch idempotently and rejects conflicting old sequence", async () => {
    const store = new MemoryStore();
    store.sequence = BigInt(8420);
    const window = parsePaymentSupplierWindow(fixture);
    await expect(applyPaymentSupplierWindows(store, [window])).resolves.toBe(1);
    await expect(applyPaymentSupplierWindows(store, [window])).resolves.toBe(0);
    expect(store.sequence).toBe(BigInt(8421));
    expect(store.rows).toHaveLength(1);

    const conflicting = clone(fixture);
    conflicting.changes[0].supplier.name = "Conflicting revision";
    await expect(applyPaymentSupplierWindows(store, [parsePaymentSupplierWindow(conflicting)]))
      .rejects.toThrow(/conflicting old sequence/);
    expect(store.rows.values().next().value?.body).toContain("Matériaux Exemple SAS");
  });

  it("does not write any page when a later page fails validation", async () => {
    const store = new MemoryStore();
    store.sequence = BigInt(8420);
    let applied = false;
    const fetchPage = async (request: PaymentSupplierPageRequest): Promise<SupplierWindow> => {
      if ("pageToken" in request) throw new Error("invalid terminal page");
      return parsePaymentSupplierWindow(page({ through: "8422", next: "next" }));
    };
    await expect((async () => {
      const pages = await fetchAllPaymentSupplierWindows(
        { mode: "incremental", afterSequence: BigInt(8420) },
        fetchPage,
      );
      await applyPaymentSupplierWindows(store, pages);
      applied = true;
    })()).rejects.toThrow("invalid terminal page");
    expect(applied).toBe(false);
    expect(store.rows.size).toBe(0);
  });

  it("recovers expired incremental cursors with bootstrap then one catch-up", async () => {
    const store = new MemoryStore();
    store.sequence = BigInt(8420);
    const bootstrapRaw = clone(fixture);
    bootstrapRaw.syncWindow.mode = "bootstrap";
    bootstrapRaw.syncWindow.afterSequenceExclusive = null;
    const bootstrap = parsePaymentSupplierWindow(bootstrapRaw);
    const catchupRaw = clone(fixture);
    catchupRaw.syncWindow.afterSequenceExclusive = "8421";
    catchupRaw.syncWindow.throughSequenceInclusive = "8422";
    catchupRaw.changes = [];
    const catchup = parsePaymentSupplierWindow(catchupRaw);
    const requests: PaymentSupplierPageRequest[] = [];
    const fetchPage = async (request: PaymentSupplierPageRequest): Promise<SupplierWindow> => {
      requests.push(request);
      if (request.mode === "incremental" && request.afterSequence === BigInt(8420)) {
        throw new PaymentSupplierCursorExpiredError(BigInt(8000));
      }
      if (request.mode === "bootstrap") return bootstrap;
      return catchup;
    };
    await expect(syncPaymentSupplierReadiness(store, {
      mode: "incremental", afterSequence: BigInt(8420),
    }, fetchPage)).resolves.toBe(1);
    expect(requests).toEqual([
      { mode: "incremental", afterSequence: BigInt(8420) },
      { mode: "bootstrap" },
      { mode: "incremental", afterSequence: BigInt(8421) },
    ]);
    expect(store.sequence).toBe(BigInt(8422));
  });

  it("fetches a private bound RIB with hash header and fails closed on hash mismatch", async () => {
    const bytes = Buffer.from("%PDF-rib");
    const sha256 = "83c600bb773d8438299271a1b1c137c77ac00542ddafdb12e9e6f988bc4f20ff";
    const rib = {
      id: "rib-1", fileName: "rib.pdf", mimeType: "application/pdf" as const, sha256,
      downloadPath: "/api/integrations/architrak/v1/suppliers/supplier-1/rib/rib-1",
      updatedAt: "2026-08-20T14:32:00Z",
    };
    const fetchImpl = vi.fn(async () => new Response(bytes));
    await expect(fetchProtectedPaymentSupplierRib("supplier-1", rib, {
      baseUrl: "https://archidoc.example", apiKey: "secret", fetchImpl,
    })).resolves.toEqual(bytes);
    const headers = new Headers(fetchImpl.mock.calls[0][1].headers);
    expect(headers.get("X-ArchiDoc-RIB-SHA256")).toBe(sha256);
    expect(headers.get("Authorization")).toBe("Bearer secret");
    await expect(fetchProtectedPaymentSupplierRib("supplier-1", { ...rib, sha256: "a".repeat(64) }, {
      baseUrl: "https://archidoc.example", apiKey: "secret", fetchImpl,
    })).rejects.toThrow(/SHA-256 mismatch/);
  });
});