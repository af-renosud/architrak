// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import {
  INVOICE_UPLOAD_ERROR_CODES,
  getInvoiceUploadErrorTitle,
} from "@shared/invoice-upload-errors";
import {
  BENCHMARK_UPLOAD_ERROR_CODES,
  getBenchmarkUploadErrorTitle,
} from "@shared/benchmark-upload-errors";

// Capture every toast() call so we can assert on title/description/variant.
type ToastInput = { title: string; description?: string; variant?: string };
const toastSpy = vi.fn<(t: ToastInput) => void>();

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

import { useToast } from "@/hooks/use-toast";

function makeFetchResponding(status: number, body: { message: string; code: string }): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

/**
 * InvoiceUploadHarness mirrors the inline mutation used by both
 * client/src/components/devis/DevisTab.tsx (InvoiceUploadDialog) and
 * client/src/components/factures/FacturesTab.tsx: parse JSON, copy
 * `err.code` onto the thrown Error, then in onError call
 * getInvoiceUploadErrorTitle(error.code) for the toast title. Locks in the
 * end-to-end mapping from server-emitted code → user-facing toast title.
 */
function InvoiceUploadHarness({ onMounted }: { onMounted: (mutate: () => void) => void }) {
  const { toast } = useToast();
  const m = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/devis/1/invoices/upload", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Upload failed" }));
        const e = new Error(err.message || "Upload failed") as Error & { code?: string };
        e.code = err.code;
        throw e;
      }
      return res.json();
    },
    onError: (error: Error & { code?: string }) => {
      const title = getInvoiceUploadErrorTitle(error.code);
      toast({ title, description: error.message, variant: "destructive" });
    },
  });
  onMounted(() => m.mutate());
  return null;
}

function BenchmarkUploadHarness({ onMounted }: { onMounted: (mutate: () => void) => void }) {
  const { toast } = useToast();
  const m = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/benchmarks/upload", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        const e = new Error(data.message || "Upload failed") as Error & { code?: string };
        e.code = data.code;
        throw e;
      }
      return data;
    },
    onError: (err: Error & { code?: string }) => {
      const title = getBenchmarkUploadErrorTitle(err.code);
      toast({ title, description: err.message, variant: "destructive" });
    },
  });
  onMounted(() => m.mutate());
  return null;
}

async function runMutationAndFlush(
  Harness: (props: { onMounted: (m: () => void) => void }) => null,
): Promise<void> {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  let trigger: () => void = () => {};
  await act(async () => {
    render(
      <QueryClientProvider client={qc}>
        <Harness onMounted={(m) => (trigger = m)} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    trigger();
    // Allow the mutation promise + onError handler to settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  toastSpy.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Invoice upload toast — server code → toast title contract", () => {
  for (const code of Object.values(INVOICE_UPLOAD_ERROR_CODES)) {
    it(`maps ${code} to "${getInvoiceUploadErrorTitle(code)}"`, async () => {
      globalThis.fetch = makeFetchResponding(400, {
        message: `server explanation for ${code}`,
        code,
      });
      await runMutationAndFlush(InvoiceUploadHarness);
      expect(toastSpy).toHaveBeenCalledTimes(1);
      const call = toastSpy.mock.calls[0][0];
      expect(call.title).toBe(getInvoiceUploadErrorTitle(code));
      expect(call.description).toBe(`server explanation for ${code}`);
      expect(call.variant).toBe("destructive");
    });
  }

  it("falls back to the generic 'Upload failed' title when the server returns no code", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ message: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    await runMutationAndFlush(InvoiceUploadHarness);
    expect(toastSpy.mock.calls[0][0].title).toBe(getInvoiceUploadErrorTitle(undefined));
  });
});

describe("Benchmark upload toast — server code → toast title contract", () => {
  for (const code of Object.values(BENCHMARK_UPLOAD_ERROR_CODES)) {
    it(`maps ${code} to "${getBenchmarkUploadErrorTitle(code)}"`, async () => {
      globalThis.fetch = makeFetchResponding(400, {
        message: `server explanation for ${code}`,
        code,
      });
      await runMutationAndFlush(BenchmarkUploadHarness);
      expect(toastSpy).toHaveBeenCalledTimes(1);
      const call = toastSpy.mock.calls[0][0];
      expect(call.title).toBe(getBenchmarkUploadErrorTitle(code));
      expect(call.description).toBe(`server explanation for ${code}`);
      expect(call.variant).toBe("destructive");
    });
  }

  it("falls back to the generic 'Upload failed' title when the server returns no code", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ message: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    await runMutationAndFlush(BenchmarkUploadHarness);
    expect(toastSpy.mock.calls[0][0].title).toBe(getBenchmarkUploadErrorTitle(undefined));
  });
});
