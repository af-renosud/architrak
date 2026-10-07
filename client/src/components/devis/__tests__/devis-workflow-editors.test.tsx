// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DevisCostAnalysisCard } from "../DevisCostAnalysisCard";
import { DevisWorkflow, VisitedDetail, WorkflowSection } from "../DevisWorkflow";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
beforeEach(() => {
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps a real cost-analysis draft and pending save mounted across disclosures, row collapse and refreshed props", async () => {
  let analysis = { rawText: "## Original analysis\nReview joinery.", status: "draft", revision: 7, warnings: [] };
  let finish: (() => void) | undefined;
  const requests = vi.fn((_url: string, options?: RequestInit) => {
    if (options?.method === "PUT") {
      const submitted = JSON.parse(String(options.body));
      return new Promise(resolve => {
        finish = () => {
          analysis = { ...analysis, rawText: submitted.rawText, revision: 8 };
          resolve({ ok: true, status: 200, json: async () => ({ analysis }), text: async () => JSON.stringify({ analysis }) });
        };
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ analysis }), text: async () => JSON.stringify({ analysis }) });
  });
  vi.stubGlobal("fetch", requests);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity,
    queryFn: async () => ({ analysis, quotationChanged: false }) }, mutations: { retry: false } } });
  const tree = (open: boolean, stage: string) => <QueryClientProvider client={client}>
    <VisitedDetail open={open}><DevisWorkflow devisId={42} stage={stage}>
      <WorkflowSection group="prepare" summary="Package"><DevisCostAnalysisCard devisId={42} translationFinalised={false} /></WorkflowSection>
    </DevisWorkflow></VisitedDetail>
  </QueryClientProvider>;
  const view = render(tree(true, "checked_internal"));
  fireEvent.click(screen.getByTestId("button-toggle-cost-analysis"));
  const editor = await screen.findByTestId("textarea-cost-analysis");
  fireEvent.change(editor, { target: { value: "## Human analysis\nPreserve this unsaved text." } });
  fireEvent.click(screen.getByRole("button", { name: /Prepare package/ }));
  await act(async () => { await client.invalidateQueries({ queryKey: ["/api/devis", 42, "cost-analysis"] }); });
  view.rerender(tree(false, "sent_to_client"));
  view.rerender(tree(true, "sent_to_client"));
  expect(screen.getByTestId("textarea-cost-analysis")).toHaveValue("## Human analysis\nPreserve this unsaved text.");
  fireEvent.click(screen.getByRole("button", { name: /Prepare package/ }));
  fireEvent.click(screen.getByTestId("button-save-cost-analysis"));
  await waitFor(() => expect(finish).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: /Prepare package/ }));
  view.rerender(tree(false, "client_signed_off"));
  await act(async () => finish?.());
  view.rerender(tree(true, "client_signed_off"));
  expect(screen.getByRole("button", { name: /Prepare package/ })).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(screen.getByRole("button", { name: /Prepare package/ }));
  await waitFor(() => expect(screen.getByTestId("button-save-cost-analysis")).toBeDisabled());
  expect(screen.getByTestId("textarea-cost-analysis")).toHaveValue("## Human analysis\nPreserve this unsaved text.");
  expect(requests.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(1);
  client.clear();
});
