// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import type { QuotationCommitmentEvidence } from "@shared/quotation-commitment";

const { request, invalidate, toast } = vi.hoisted(() => ({
  request: vi.fn(), invalidate: vi.fn(), toast: vi.fn(),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: request,
  queryClient: { invalidateQueries: invalidate },
  projectScopedKey: (id: string, ...parts: string[]) => ["/api/projects", String(id), ...parts],
  ApiError: class ApiError extends Error {},
}));
import { ProjectSharePublishControl } from "../DevisTab";

const key = ["/api/projects", "24", "client-share"];
const activeLink = { expiresAt: "2099-01-01T00:00:00Z", revokedAt: null };
const unsigned: QuotationCommitmentEvidence = { accountingState: "active", status: "pending", signOffStage: "approved_to_sign" };
function mount({
  quotation = unsigned, token = activeLink as { expiresAt: string; revokedAt: string | null } | null, published = false, archived = false,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
} = {}) {
  client.setQueryData(key, { token, publishedDevisIds: published ? [42] : [] });
  const toggle = vi.fn();
  render(<QueryClientProvider client={client}><div onClick={toggle} onKeyDown={toggle}>
    <ProjectSharePublishControl projectId="24" devisId={42} quotation={quotation} isArchived={archived} />
  </div></QueryClientProvider>);
  return { client, toggle };
}
beforeEach(() => {
  vi.clearAllMocks();
  request.mockResolvedValue({ json: async () => ({}) });
});
afterEach(cleanup);

describe("collapsed quotation client visibility", () => {
  it("places exactly one full-quotation control on the main record, beside distinct budget controls", () => {
    const source = readFileSync("client/src/components/devis/DevisTab.tsx", "utf8");
    expect(source.match(/<ProjectSharePublishControl /g)).toHaveLength(1);
    const row = source.slice(source.indexOf("function DevisRow("), source.indexOf("export function DevisTab("));
    expect(row).toContain("<ProjectSharePublishControl");
    expect(row).toContain("<ClientBudgetControls");
    expect(row.indexOf("<ProjectSharePublishControl")).toBeLessThan(row.indexOf("<VisitedDetail"));
  });

  it("shares unsigned quotations through the existing explicit endpoint without toggling the card", async () => {
    const { toggle } = mount();
    expect(screen.getByText("Not shared")).toBeVisible();
    const button = screen.getByRole("button", { name: "Share full quotation" });
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    await waitFor(() => expect(request).toHaveBeenCalledWith("POST", "/api/projects/24/client-share/publish", { devisId: 42 }));
    expect(toggle).not.toHaveBeenCalled();
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: key }));
  });

  it("shows shared state and supports removing an explicit unsigned share", async () => {
    mount({ published: true });
    expect(screen.getByText("Shared with client")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing full quotation" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("POST", "/api/projects/24/client-share/unpublish", { devisId: 42 }));
  });

  it.each([
    { signOffStage: "client_signed_off" },
    { archisignEnvelopeStatus: "signed" },
    { signedPdfStorageKey: "signed/document.pdf" },
    { signedOffVia: "manual_upload", manualSignoffAt: "2026-01-10" },
    { status: "signed" },
  ])("recognizes durable signed evidence %j without a publish or unpublish action", (evidence) => {
    mount({ quotation: { ...unsigned, ...evidence }, published: true });
    expect(screen.getByText("Signed — visible automatically")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { status: "void" }, { status: "cancelled" }, { status: "superseded" },
    { accountingState: "superseded" }, { accountingState: "draft" },
  ])("excludes inactive signed quotations %j", (lifecycle) => {
    mount({ quotation: { ...unsigned, signOffStage: "client_signed_off", ...lifecycle }, published: true });
    expect(screen.getByText("Not shared · inactive quotation")).toBeVisible();
    expect(screen.queryByText("Signed — visible automatically")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps signed automatic visibility independent of explicit membership and flags missing access", () => {
    mount({ quotation: { ...unsigned, status: "signed" }, token: null });
    expect(screen.getByText("Signed — visible automatically")).toBeVisible();
    expect(screen.getByText(/Client access needs a valid project link/)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    null,
    { expiresAt: "2001-01-01", revokedAt: null },
    { expiresAt: "2099-01-01", revokedAt: "2026-01-01" },
    { expiresAt: "invalid", revokedAt: null },
  ])("does not claim client access through an invalid link %j", (token) => {
    mount({ token, published: true });
    expect(screen.getByText("Not shared")).toBeVisible();
    expect(screen.getByText(/Sharing is saved, but client access needs/)).toBeVisible();
    expect(screen.queryByText("Shared with client")).not.toBeInTheDocument();
  });

  it("disables unsigned sharing until there is a valid link", () => {
    mount({ token: null });
    expect(screen.getByRole("button", { name: "Share full quotation" })).toBeDisabled();
  });

  it("preserves archived project read-only behavior", () => {
    mount({ archived: true });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("reports mutation errors and leaves a retryable share action", async () => {
    request.mockRejectedValueOnce(new Error("Connection lost"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Share full quotation" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Cannot publish", variant: "destructive" })));
    expect(screen.getByRole("button", { name: "Share full quotation" })).toBeEnabled();
  });

  it("reuses fresh project state across many collapsed cards without extra requests", () => {
    const queryFn = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { queryFn, retry: false } } });
    mount({ client });
    render(<QueryClientProvider client={client}>
      <ProjectSharePublishControl projectId="24" devisId={43} quotation={unsigned} isArchived={false} />
      <ProjectSharePublishControl projectId="24" devisId={44} quotation={unsigned} isArchived={false} />
    </QueryClientProvider>);
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("shows a skeleton during loading and deduplicates concurrent project requests", async () => {
    let resolve!: (value: unknown) => void;
    const queryFn = vi.fn(() => new Promise(done => { resolve = done; }));
    const client = new QueryClient({ defaultOptions: { queries: { queryFn, retry: false } } });
    render(<QueryClientProvider client={client}>
      {[42, 43].map(devisId => <ProjectSharePublishControl key={devisId} projectId="24" devisId={devisId} quotation={unsigned} isArchived={false} />)}
    </QueryClientProvider>);
    expect(screen.getAllByLabelText("Loading full quotation visibility")).toHaveLength(2);
    expect(queryFn).toHaveBeenCalledTimes(1);
    resolve({ token: activeLink, publishedDevisIds: [] });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Share full quotation" })).toHaveLength(2));
  });

  it("provides an explicit retry rather than reporting a failed lookup as not shared", async () => {
    const queryFn = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue({ token: activeLink, publishedDevisIds: [42] });
    const client = new QueryClient({ defaultOptions: { queries: { queryFn, retry: false } } });
    render(<QueryClientProvider client={client}>
      <ProjectSharePublishControl projectId="24" devisId={42} quotation={unsigned} isArchived={false} />
    </QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Retry visibility" }));
    expect(await screen.findByText("Shared with client")).toBeVisible();
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});
