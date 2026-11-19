// @vitest-environment jsdom
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DevisLineContext } from "@shared/schema";
import { ContextGenerationActions, LineContextGenerationAction } from "../ContextGenerationActions";
import { useContextGeneration, useGenerateLineContext } from "../useContextGeneration";
import { quotationWorkBlocked, setQuotationWork } from "../quotation-review-state";

const idle = { running: false, completed: 0, skipped: 0, failed: 0, error: null };
const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Saved explanation" }] }] };
const context = { id: 3, devisId: 986, devisLineItemId: 71, revision: 1, document: doc } as DevisLineContext;
const fetchMock = vi.fn();
let client: QueryClient;
function Wrapper({ children }: PropsWithChildren) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  fetchMock.mockReset().mockResolvedValue(json(idle));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  client.clear();
  setQuotationWork(986, "test-draft", false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fill-empty context assistance", () => {
  it("generates a line using the empty POST contract, refreshes contexts and displays warnings", async () => {
    fetchMock.mockResolvedValue(json({ context, sources: [{ title: "Manufacturer", uri: "https://example.org/spec" }], warning: "Confirm the product reference." }));
    const invalidate = vi.spyOn(client, "invalidateQueries");
    render(<LineContextGenerationAction devisId={986} lineItemId={71} context={null} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Generate explanation" }));
    expect(await screen.findByText("Confirm the product reference.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/devis/986/line-contexts/71/generate", expect.objectContaining({
      method: "POST", body: "{}", credentials: "include",
    }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/devis", 986, "line-contexts"] });
    expect(quotationWorkBlocked(986)).toBe(false);
  });

  it("never offers replacement for saved text or image-only context", () => {
    const { rerender } = render(<LineContextGenerationAction devisId={986} lineItemId={71} context={context} />, { wrapper: Wrapper });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(<LineContextGenerationAction devisId={986} lineItemId={71} context={{
      ...context, document: { type: "doc", content: [{ type: "image", attrs: { assetId: 8 } }] },
    }} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the API error and supports a per-line retry", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "Research is temporarily unavailable." }, 503))
      .mockResolvedValueOnce(json({ context, sources: [], warning: null }));
    render(<LineContextGenerationAction devisId={986} lineItemId={71} context={null} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Generate explanation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Research is temporarily unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Retry explanation" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("disables generation for local unsaved work and checks again at mutation time", async () => {
    setQuotationWork(986, "test-draft", true, "Unsaved context");
    render(<LineContextGenerationAction devisId={986} lineItemId={71} context={null} />, { wrapper: Wrapper });
    expect(screen.getByRole("button", { name: "Generate explanation" })).toBeDisabled();
    const { result } = renderHook(() => useGenerateLineContext(986, 71, false), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow("Save the working draft");
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours the read-only/translation lock on individual and bulk generation", async () => {
    render(<><LineContextGenerationAction devisId={986} lineItemId={71} context={null} disabled />
      <ContextGenerationActions devisId={986} disabled translationStatus="finalised" hasLines /></>, { wrapper: Wrapper });
    expect(screen.getByRole("button", { name: "Generate explanation" })).toBeDisabled();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Fill empty contexts" })).toBeDisabled();
    expect(fetchMock.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });

  it("loads server-started work on visit, invalidates progress and completion, and stops polling", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(json({ ...idle, running: true }))
      .mockResolvedValueOnce(json({ ...idle, running: true, completed: 1 }))
      .mockResolvedValue(json({ ...idle, completed: 2 }));
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useContextGeneration(986, false, "draft"), { wrapper: Wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(result.current.state.data?.running).toBe(true);
    expect(quotationWorkBlocked(986)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2050); });
    expect(result.current.state.data?.completed).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2050); });
    expect(result.current.state.data?.running).toBe(false);
    expect(quotationWorkBlocked(986)).toBe(false);
    const contextInvalidations = invalidate.mock.calls.filter(([arg]) => arg?.queryKey?.[2] === "line-contexts");
    expect(contextInvalidations).toHaveLength(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does an initial GET even when an idle state is cached forever", async () => {
    client.setQueryData(["/api/devis", 986, "context-generation"], idle);
    fetchMock.mockResolvedValue(json({ ...idle, running: true }));
    const { result } = renderHook(() => useContextGeneration(986, false, "draft"), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.state.data?.running).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("checks for the automatic job again after a new translation completes", async () => {
    const { result, rerender } = renderHook(({ status }) => useContextGeneration(986, false, status), {
      wrapper: Wrapper, initialProps: { status: "processing" },
    });
    await waitFor(() => expect(result.current.state.data?.running).toBe(false));
    fetchMock.mockResolvedValue(json({ ...idle, running: true }));
    rerender({ status: "draft" });
    await waitFor(() => expect(result.current.state.data?.running).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("starts bulk fill, shows progress and offers retry for failed rows without overwriting", async () => {
    let started = false;
    fetchMock.mockImplementation(async (_url, init) => {
      if (init.method === "POST") { started = true; return json({}); }
      return json(started ? { ...idle, completed: 2, skipped: 1, failed: 1, error: "One source lookup failed." } : idle);
    });
    render(<ContextGenerationActions devisId={986} disabled={false} translationStatus="draft" hasLines />, { wrapper: Wrapper });
    const button = await screen.findByRole("button", { name: "Fill empty contexts" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByText("One source lookup failed.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("2 filled · 1 skipped · 1 failed");
    expect(screen.getByRole("button", { name: "Retry empty contexts" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledWith("/api/devis/986/context-generation", expect.objectContaining({ method: "POST", body: "{}" }));
    expect(screen.getByText(/AI draft · review before sharing/)).toBeInTheDocument();
  });

  it("shows a bulk start API error and can retry", async () => {
    fetchMock.mockImplementation(async (_url, init) => init.method === "POST"
      ? json({ message: "Context service is busy." }, 503) : json(idle));
    render(<ContextGenerationActions devisId={986} disabled={false} translationStatus="draft" hasLines />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("button", { name: "Fill empty contexts" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Fill empty contexts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Context service is busy.");
    expect(screen.getByRole("button", { name: "Retry empty contexts" })).toBeEnabled();
    expect(quotationWorkBlocked(986)).toBe(false);
  });

  it("shows status errors with retry and never starts a second job with unknown status", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "Status unavailable." }, 503)).mockResolvedValue(json(idle));
    render(<ContextGenerationActions devisId={986} disabled={false} translationStatus="draft" hasLines />, { wrapper: Wrapper });
    expect(await screen.findByRole("alert")).toHaveTextContent("Status unavailable.");
    expect(screen.getByRole("button", { name: "Fill empty contexts" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry status" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Fill empty contexts" })).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
