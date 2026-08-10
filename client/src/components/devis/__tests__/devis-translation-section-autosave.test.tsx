// @vitest-environment jsdom
//
// Regression guard for the autosave-loses-typed-edits bug.
//
// History: persistLine and persistHeader had a dedup early-return that
// compared the incoming patch against `localLines` / `localHeader`. Because
// the textarea's onChange writes the new value into local state BEFORE
// onBlur runs, that comparison was always equal — so PATCH never fired
// and every typed edit was lost on refetch / page reload.
//
// This test types into a per-line English textarea and the document-summary
// header textarea, blurs each, and asserts that apiRequest was called with
// PATCH /api/devis/:id/translation carrying the new values. If anyone
// reintroduces a local-state dedup short-circuit, this test will fail
// because patchMutation.mutate never gets called.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const apiRequestMock = vi.fn();

vi.mock("@/lib/queryClient", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/queryClient");
  return {
    ...actual,
    apiRequest: (...args: unknown[]) => apiRequestMock(...args),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { DevisTranslationSection } from "../DevisTranslationSection";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function renderSection() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  // Pre-seed the translation query so the component renders the editable
  // textareas immediately without needing the network on mount.
  qc.setQueryData(["/api/devis", 42, "translation"], {
    id: 1,
    devisId: 42,
    status: "draft",
    headerTranslated: { summary: "Original summary" },
    lineTranslations: [
      { lineNumber: 1, originalDescription: "FR ligne 1", translation: "EN line 1", explanation: null, edited: false },
    ],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const lineItems = [
    {
      id: 100,
      devisId: 42,
      lineNumber: 1,
      description: "FR ligne 1",
      quantity: "1",
      unit: "u",
      unitPriceHt: "10.00",
      totalHt: "10.00",
      percentComplete: "0",
      checkStatus: "unchecked",
      checkNotes: null,
    } as unknown as Parameters<typeof DevisTranslationSection>[0]["lineItems"][number],
  ];

  return render(
    <QueryClientProvider client={qc}>
      <DevisTranslationSection devisId={42} devisCode="DEV-42" lineItems={lineItems} />
    </QueryClientProvider>,
  );
}

describe("DevisTranslationSection autosave (regression #146)", () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
    apiRequestMock.mockResolvedValue(jsonResponse({ ok: true }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("PATCHes the typed English translation when the line textarea blurs", async () => {
    renderSection();

    const textarea = await screen.findByTestId("input-translation-42-1");
    fireEvent.change(textarea, { target: { value: "EDITED English line 1" } });
    fireEvent.blur(textarea, { target: { value: "EDITED English line 1" } });

    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalled();
    });

    const patchCall = apiRequestMock.mock.calls.find(
      ([method, url]) => method === "PATCH" && typeof url === "string" && url.includes("/translation"),
    );
    expect(patchCall, "expected a PATCH /api/devis/42/translation call").toBeDefined();
    const [, , body] = patchCall!;
    expect(body).toMatchObject({
      lines: [
        expect.objectContaining({
          lineNumber: 1,
          translation: "EDITED English line 1",
        }),
      ],
    });
  });

  it("PATCHes the document summary when the header textarea blurs", async () => {
    renderSection();

    const summary = await screen.findByTestId("text-translation-summary-42");
    fireEvent.change(summary, { target: { value: "EDITED summary" } });
    fireEvent.blur(summary, { target: { value: "EDITED summary" } });

    await waitFor(() => {
      const headerCall = apiRequestMock.mock.calls.find(
        ([method, url, body]) =>
          method === "PATCH" &&
          typeof url === "string" &&
          url.includes("/translation") &&
          body &&
          typeof body === "object" &&
          "header" in (body as object),
      );
      expect(headerCall, "expected a PATCH carrying the edited header").toBeDefined();
      const [, , body] = headerCall!;
      expect((body as { header: { summary: string } }).header.summary).toBe("EDITED summary");
    });
  });

  it("PATCHes again on a second edit even if the first save already echoed the value", async () => {
    // Simulates the original-bug failure mode: after the first save, the
    // server roundtrip would echo the typed value back into local state, and
    // a naive dedup check would then refuse to send the next edit.
    renderSection();

    const textarea = await screen.findByTestId("input-translation-42-1");

    fireEvent.change(textarea, { target: { value: "First edit" } });
    fireEvent.blur(textarea, { target: { value: "First edit" } });

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));

    fireEvent.change(textarea, { target: { value: "Second edit" } });
    fireEvent.blur(textarea, { target: { value: "Second edit" } });

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(2));

    const lastBody = apiRequestMock.mock.calls.at(-1)![2] as {
      lines: Array<{ translation: string }>;
    };
    expect(lastBody.lines[0].translation).toBe("Second edit");
  });
});

// ---------------------------------------------------------------------------
// Task 364 — lost edits / racing saves in translation mode.
// ---------------------------------------------------------------------------

function renderSectionWithClient(lineCount = 2) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  qc.setQueryData(["/api/devis", 42, "translation"], {
    id: 1,
    devisId: 42,
    status: "draft",
    headerTranslated: { summary: "Original summary" },
    lineTranslations: Array.from({ length: lineCount }, (_, i) => ({
      lineNumber: i + 1,
      originalDescription: `FR ligne ${i + 1}`,
      translation: `EN line ${i + 1}`,
      explanation: null,
      edited: false,
    })),
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const lineItems = Array.from({ length: lineCount }, (_, i) => ({
    id: 100 + i,
    devisId: 42,
    lineNumber: i + 1,
    description: `FR ligne ${i + 1}`,
    quantity: "1",
    unit: "u",
    unitPriceHt: "10.00",
    totalHt: "10.00",
    percentComplete: "0",
    checkStatus: "unchecked",
    checkNotes: null,
  })) as unknown as Parameters<typeof DevisTranslationSection>[0]["lineItems"];

  const utils = render(
    <QueryClientProvider client={qc}>
      <DevisTranslationSection devisId={42} devisCode="DEV-42" lineItems={lineItems} />
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

describe("DevisTranslationSection save serialization + buffer protection (Task 364)", () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
    apiRequestMock.mockResolvedValue(jsonResponse({ ok: true }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("serializes rapid multi-field blurs so the latest values always win", async () => {
    // Hold the first PATCH open so the second blur happens while it's in
    // flight; the queued save must carry BOTH edits (rebuilt from the latest
    // local buffers), so an older full-array payload can never win.
    let releaseFirst!: () => void;
    apiRequestMock
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseFirst = () => resolve(jsonResponse({ ok: true })))),
      )
      .mockResolvedValue(jsonResponse({ ok: true }));

    renderSectionWithClient(2);

    const line1 = await screen.findByTestId("input-translation-42-1");
    const line2 = await screen.findByTestId("input-translation-42-2");

    fireEvent.change(line1, { target: { value: "Edited ONE" } });
    fireEvent.blur(line1, { target: { value: "Edited ONE" } });
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));

    // Second edit while the first PATCH is still in flight.
    fireEvent.change(line2, { target: { value: "Edited TWO" } });
    fireEvent.blur(line2, { target: { value: "Edited TWO" } });
    // Single-flight: no second request yet.
    expect(apiRequestMock).toHaveBeenCalledTimes(1);

    releaseFirst();
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(2));

    const lastBody = apiRequestMock.mock.calls.at(-1)![2] as {
      lines: Array<{ lineNumber: number; translation: string }>;
    };
    expect(lastBody.lines.find((l) => l.lineNumber === 1)?.translation).toBe("Edited ONE");
    expect(lastBody.lines.find((l) => l.lineNumber === 2)?.translation).toBe("Edited TWO");
  });

  it("keeps an unblurred edit typed during an in-flight save, and flushes it on unmount", async () => {
    // Edit A blurred (PATCH held open) → edit B typed WITHOUT blurring while
    // A is in flight → A resolves and the invalidated refetch delivers server
    // state containing A but not B. B must stay visible (dirty buffers are
    // never rebuilt from server data) and must go out in the unmount flush.
    let releaseFirst!: () => void;
    apiRequestMock
      .mockImplementationOnce(
        () => new Promise((resolve) => (releaseFirst = () => resolve(jsonResponse({ ok: true })))),
      )
      .mockResolvedValue(jsonResponse({ ok: true }));

    const { qc, unmount } = renderSectionWithClient(2);

    const line1 = await screen.findByTestId("input-translation-42-1");
    const line2 = await screen.findByTestId("input-translation-42-2");

    fireEvent.change(line1, { target: { value: "Edit A" } });
    fireEvent.blur(line1, { target: { value: "Edit A" } });
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));

    // Type B while A's PATCH is in flight — no blur.
    fireEvent.change(line2, { target: { value: "Edit B unblurred" } });

    releaseFirst();
    // Simulate the post-A refetch: server has A but NOT B.
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));
    qc.setQueryData(["/api/devis", 42, "translation"], {
      id: 1,
      devisId: 42,
      status: "edited",
      headerTranslated: { summary: "Original summary" },
      lineTranslations: [
        { lineNumber: 1, originalDescription: "FR ligne 1", translation: "Edit A", explanation: null, edited: true },
        { lineNumber: 2, originalDescription: "FR ligne 2", translation: "EN line 2", explanation: null, edited: false },
      ],
      updatedAt: "2026-01-01T00:10:00.000Z",
    });

    // B is still on screen — the refetch must not have rebuilt the buffers.
    await waitFor(() => {
      expect((screen.getByTestId("input-translation-42-2") as HTMLTextAreaElement).value).toBe(
        "Edit B unblurred",
      );
    });

    // Navigating away flushes B.
    unmount();
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(2));
    const lastBody = apiRequestMock.mock.calls.at(-1)![2] as {
      lines: Array<{ lineNumber: number; translation: string }>;
    };
    expect(lastBody.lines.find((l) => l.lineNumber === 2)?.translation).toBe("Edit B unblurred");
    expect(lastBody.lines.find((l) => l.lineNumber === 1)?.translation).toBe("Edit A");
  });

  it("a refetch never wipes an in-progress (unsaved) edit", async () => {
    const { qc } = renderSectionWithClient(1);

    const line1 = await screen.findByTestId("input-translation-42-1");
    fireEvent.change(line1, { target: { value: "typing in progress" } });

    // A stale refetch response lands (new updatedAt, old content) while the
    // edit is dirty — the local buffer must NOT be rebuilt from it.
    qc.setQueryData(["/api/devis", 42, "translation"], {
      id: 1,
      devisId: 42,
      status: "edited",
      headerTranslated: { summary: "Original summary" },
      lineTranslations: [
        { lineNumber: 1, originalDescription: "FR ligne 1", translation: "STALE server value", explanation: null, edited: false },
      ],
      updatedAt: "2026-01-01T00:05:00.000Z",
    });

    await waitFor(() => {
      expect((screen.getByTestId("input-translation-42-1") as HTMLTextAreaElement).value).toBe(
        "typing in progress",
      );
    });
  });

  it("flushes a typed-but-unblurred edit when the section unmounts (navigation)", async () => {
    const { unmount } = renderSectionWithClient(1);

    const line1 = await screen.findByTestId("input-translation-42-1");
    fireEvent.change(line1, { target: { value: "typed then navigated" } });
    expect(apiRequestMock).not.toHaveBeenCalled();

    unmount();

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalled());
    const [method, url, body] = apiRequestMock.mock.calls.at(-1)!;
    expect(method).toBe("PATCH");
    expect(url).toContain("/api/devis/42/translation");
    expect(
      (body as { lines: Array<{ translation: string }> }).lines[0].translation,
    ).toBe("typed then navigated");
  });
});
