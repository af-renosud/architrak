import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    ARCHIDOC_BASE_URL: "https://archiouvro.com",
    ARCHIDOC_SYNC_API_KEY: "unit-test-bearer-secret",
  },
}));

vi.mock("../../env", () => ({ env: mockEnv }));

import {
  ArchidocFetchError,
  fetchTechnicalLots,
  getLastTechnicalLotsFetchDiagnostic,
} from "../sync-client";

const VALID_RESPONSE = {
  lots: [
    {
      id: "lot-1",
      code: "01",
      labelFr: "Gros œuvre",
      displayOrder: 1,
      isActive: true,
      deletedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
  ],
  catalogue: {
    revision: 9,
    changedAt: "2026-08-01T00:00:00.000Z",
  },
};

let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockEnv.ARCHIDOC_BASE_URL = "https://archiouvro.com";
  mockEnv.ARCHIDOC_SYNC_API_KEY = "unit-test-bearer-secret";
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockFetchResponse(body: unknown, status: number) {
  const fetchMock = vi.fn().mockResolvedValue(
    typeof body === "string"
      ? new Response(body, { status })
      : new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function expectFetchError(code: string, status: number | null) {
  let caught: unknown;
  try {
    await fetchTechnicalLots();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ArchidocFetchError);
  expect((caught as ArchidocFetchError).diagnostic).toMatchObject({
    endpoint: "/api/integrations/architrak/technical-lots",
    outcome: "error",
    code,
    status,
  });
  expect(getLastTechnicalLotsFetchDiagnostic()).toMatchObject({ code, status });
}

describe("fetchTechnicalLots diagnostics", () => {
  it("uses the exact authoritative endpoint, backend bearer header, and validates success", async () => {
    const fetchMock = mockFetchResponse(VALID_RESPONSE, 200);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    const result = await fetchTechnicalLots();

    expect(result).toEqual(VALID_RESPONSE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://archiouvro.com/api/integrations/architrak/technical-lots");
    expect(options.method).toBe("GET");
    expect(options.headers).toMatchObject({
      Authorization: "Bearer unit-test-bearer-secret",
      Accept: "application/json",
    });
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(getLastTechnicalLotsFetchDiagnostic()).toMatchObject({
      outcome: "success",
      status: 200,
      code: null,
      reason: "Validated 1 technical-lot records.",
    });
    expect(infoSpy).toHaveBeenCalledOnce();
  });

  it.each([
    [401, "unauthorized"],
    [404, "not_found"],
    [503, "unavailable"],
  ])("categorizes HTTP %s without exposing the response body", async (status, code) => {
    mockFetchResponse("upstream-private-detail", status);

    await expectFetchError(code, status);

    const serializedLogs = JSON.stringify(warnSpy.mock.calls);
    expect(serializedLogs).not.toContain("upstream-private-detail");
    expect(serializedLogs).not.toContain("unit-test-bearer-secret");
  });

  it("categorizes a timeout without retaining the thrown error text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("private timeout detail", "TimeoutError")),
    );

    await expectFetchError("timeout", null);

    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("private timeout detail");
  });

  it("categorizes a network failure without retaining the thrown error text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network detail with unit-test-bearer-secret")),
    );

    await expectFetchError("network_error", null);

    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("unit-test-bearer-secret");
  });

  it("categorizes malformed JSON as an invalid response", async () => {
    mockFetchResponse("not-json", 200);
    await expectFetchError("invalid_response", 200);
  });

  it("categorizes a contract-invalid payload without exposing its values", async () => {
    mockFetchResponse({ lots: [{ secret: "payload-private-detail" }], catalogue: null }, 200);

    await expectFetchError("invalid_response", 200);

    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("payload-private-detail");
  });

  it("reports missing configuration before making a request", async () => {
    mockEnv.ARCHIDOC_SYNC_API_KEY = "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expectFetchError("not_configured", null);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("categorizes a malformed base URL without exposing its value", async () => {
    mockEnv.ARCHIDOC_BASE_URL = "private malformed base URL";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expectFetchError("invalid_configuration", null);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("private malformed base URL");
  });
});