// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import Dashboard from "@/pages/dashboard";
import { DashboardDisclosure } from "../DashboardDisclosure";
import { queryClient } from "@/lib/queryClient";
import * as api from "@/lib/queryClient";
import { summarizeOutstandingFees } from "@shared/fee-description";
import { useState } from "react";
import userEvent from "@testing-library/user-event";

vi.mock("@/components/layout/AppLayout", () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("@/components/dashboard/BurnUpChart", () => ({ default: () => <div>Source chart</div> }));
vi.mock("@/components/certificats/ArchitectInvoiceSection", () => ({
  ArchitectInvoiceBadge: () => null, ArchitectInvoiceManager: () => null,
}));

const summary = {
  gmailLastCheck: "2026-06-01T10:00:00Z", gmailConfigured: true, gmailPolling: true,
  gmailLastPollStatus: "success", gmailLastPollError: null,
  overview: { activeProjects: 1, totalProjects: 1 },
  projectSummaries: [{
    id: 9, name: "Test project", code: "TEST", clientName: "Client", status: "active",
    devisCount: 2, devisApprovedCount: 1, devisUnapprovedCount: 1, allDevisSigned: false,
    invoiceCount: 1, invoiceApprovedCount: 1, invoiceUnapprovedCount: 0, agentStatus: "ok", agentIssueCount: 0,
  }],
  urgentItems: [{ id: 2, projectId: 9, type: "cert_draft", label: "Certificate draft", amount: "120" }],
  recentActivity: [{ projectId: 9, type: "invoice", label: "Invoice recorded", contractor: "Contractor", date: "2026-06-01", amount: "120" }],
};
const health = { pollHealth: { level: "ok", ageMs: 10, message: null }, needsAttentionCount: 2, persistentFailureCount: 1 };

function seed() {
  queryClient.setQueryData(["/api/dashboard/summary"], summary);
  queryClient.setQueryData(["/api/auth/user"], { id: 1, gmailLinked: true });
  queryClient.setQueryData(["/api/gmail/status"], health);
  queryClient.setQueryData(["/api/gmail/stuck-messages"], [{ userId: 1, messageId: "stuck/test", failCount: 5, lastFailedAt: "2026-06-01T10:00:00Z" }]);
  queryClient.setQueryData(["/api/certificats/unsent"], [{
    certificatId: 42, certificateRef: "CERT-42", certificateStatus: "sent", netToPayTtc: "120",
    projectId: 9, projectName: "Test project", contractorId: 3, contractorName: "Contractor", isSolde: false,
  }]);
  queryClient.setQueryData(["/api/design-contracts/dashboard-actions"], [{
    milestoneId: 5, contractId: 4, projectId: 9, projectName: "Test project", projectCode: "TEST",
    labelFr: "Design stage", amountTtc: "240", reachedAt: null, triggerEvent: "test",
  }]);
  queryClient.setQueryData(["/api/architect-fee-invoices", { status: "pending_review" }], [{ id: 6 }, { id: 7 }]);
  queryClient.setQueryData(["/api/fees/outstanding"], summarizeOutstandingFees([{
    entryId: 8, feeId: 1, projectId: 9, projectName: "Test project", projectCode: "TEST",
    contractorName: "Contractor", invoiceId: 2, invoiceNumber: "INV-2", devisId: 3, devisCode: "D-3",
    amountHt: 100, amountTtc: 120, feePercentage: 10, feeAmountHt: 10, createdAt: "2026-06-01", ageDays: 10,
  }]));
  queryClient.setQueryData(["/api/pennylane/feature-flags"], { configured: true, pushEnabled: false, dryRun: false });
}
function mount() {
  return render(<QueryClientProvider client={queryClient}><Dashboard /></QueryClientProvider>);
}
function disclosure(title: string) {
  return screen.getByRole("button", { name: new RegExp(title, "i") });
}

beforeEach(() => { queryClient.clear(); seed(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); queryClient.clear(); });

describe("action-first dashboard", () => {
  it("orders urgent and dispatch first, retains counts/summaries, and closes supporting sections by default", () => {
    mount();
    const urgent = disclosure("Urgent items");
    const dispatch = disclosure("Certificates awaiting dispatch");
    expect(urgent).toHaveAttribute("aria-expanded", "true");
    expect(dispatch).toHaveAttribute("aria-expanded", "true");
    expect(urgent.compareDocumentPosition(dispatch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const titles = ["Design milestones awaiting invoice", "Detected fee invoices to verify", "Accounting references to reconcile", "Project financial health", "Recent activity"];
    let previous = dispatch;
    for (const title of titles) {
      const button = disclosure(title);
      expect(button).toHaveAttribute("aria-expanded", "false");
      expect(previous.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      previous = button;
    }
    expect(disclosure("Detected fee invoices to verify")).toHaveTextContent("2");
    expect(disclosure("Design milestones awaiting invoice")).toHaveTextContent("240");
    expect(disclosure("Accounting references to reconcile")).toHaveTextContent("10");
    expect(disclosure("Recent activity")).toHaveTextContent("1");
    expect(screen.getByTestId("dispatch-summary-42")).toBeVisible();
    expect(screen.getByText("dispatch task, not a payment request", { exact: false })).toBeVisible();
    expect(screen.getByRole("link", { name: "Your projects ↓" })).toHaveAttribute("href", "#dashboard-projects");
    expect(screen.getByTestId("card-project-9").closest("a")).toHaveAttribute("href", "/projets/9");
  });

  it("keeps the project directory expanded by default and mounted when collapsed, with its jump target intact", () => {
    mount();
    const directory = disclosure("Project directory");
    const project = screen.getByTestId("card-project-9");
    expect(directory).toHaveAttribute("aria-expanded", "true");
    expect(directory).toHaveTextContent("1");
    expect(directory.closest("aside")).toHaveAttribute("id", "dashboard-projects");
    fireEvent.click(directory);
    expect(directory).toHaveAttribute("aria-expanded", "false");
    expect(project).not.toBeVisible();
    expect(screen.getByRole("link", { name: "Your projects ↓" })).toHaveAttribute("href", "#dashboard-projects");
    fireEvent.click(directory);
    expect(screen.getByTestId("card-project-9")).toBe(project);
    expect(project).toBeVisible();
    expect(project.closest("a")).toHaveAttribute("href", "/projets/9");
  });

  it("distinguishes waiting for payment from architect actions and uses standalone outlined navigation actions", () => {
    queryClient.setQueryData(["/api/dashboard/summary"], {
      ...summary,
      urgentItems: [
        ...summary.urgentItems,
        { id: 3, projectId: 9, type: "overdue_invoice", label: "Overdue invoice", amount: "240" },
        { id: 4, projectId: 9, type: "cert_review", label: "Certificate review", amount: "120" },
        { id: 5, projectId: 9, type: "anomaly", label: "Quotation query", amount: "0" },
      ],
    });
    mount();
    expect(disclosure("Urgent items")).toHaveTextContent("4");
    expect(screen.getByTestId("text-urgent-next-step-0")).toHaveTextContent("Your action · complete the certificate");
    expect(screen.getByTestId("text-urgent-next-step-1")).toHaveTextContent("Waiting on payment · review the record before following up");
    expect(screen.getByTestId("text-urgent-next-step-2")).toHaveTextContent("Your action · review the certificate");
    expect(screen.getByTestId("text-urgent-next-step-3")).toHaveTextContent("Your action · resolve the quotation queries");
    ["Continue draft", "Review invoice", "Review certificate", "Review queries"].forEach((label, index) => {
      const row = screen.getByTestId(`card-urgent-${index}`);
      const action = within(row).getByRole("link", { name: label });
      expect(row.closest("a")).toBeNull();
      expect(action).toHaveAttribute("href", "/projets/9");
      expect(action).toHaveClass("border", "justify-self-end");
      expect(action.querySelector("a, button, input")).toBeNull();
      expect(within(row).queryByRole("button")).toBeNull();
    });
    expect(screen.getByTestId("text-urgent-amount-1")).toHaveTextContent("240");
  });

  it("preserves an in-progress accounting reference on collapse and keeps its save endpoint", async () => {
    const request = vi.spyOn(api, "apiRequest").mockResolvedValue({ json: async () => ({}) } as Response);
    mount();
    fireEvent.click(disclosure("Accounting references to reconcile"));
    fireEvent.click(screen.getByTestId("button-mark-invoiced-8"));
    const input = screen.getByTestId("input-pennylane-ref-8");
    fireEvent.change(input, { target: { value: "PL-123" } });
    fireEvent.click(disclosure("Accounting references to reconcile"));
    expect(input).not.toBeVisible();
    fireEvent.click(disclosure("Accounting references to reconcile"));
    expect(input).toHaveValue("PL-123");
    fireEvent.click(screen.getByTestId("button-confirm-mark-invoiced-8"));
    await waitFor(() => expect(request).toHaveBeenCalledWith("POST", "/api/fee-entries/8/mark-invoiced", { pennylaneInvoiceRef: "PL-123" }));
  });

  it("retains dispatch dialog and missing-invoice confirmation guard after collapsing its section", async () => {
    const request = vi.spyOn(api, "apiRequest").mockResolvedValue({ json: async () => ({}) } as Response);
    vi.spyOn(queryClient, "fetchQuery").mockResolvedValue({ attached: false, locked: false });
    mount();
    const dispatchToggle = disclosure("Certificates awaiting dispatch");
    fireEvent.click(screen.getByTestId("card-unsent-certificats"));
    // Programmatic toggle proves the dialog owner is not destroyed by collapse.
    fireEvent.click(dispatchToggle);
    expect(screen.getByTestId("dialog-unsent-certificats")).toBeVisible();
    expect(screen.getByTestId("label-false-sent-certificat-42")).toBeVisible();
    fireEvent.click(screen.getByTestId("button-send-unsent-certificat-42"));
    await screen.findByTestId("architect-invoice-send-reminder");
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("send-without-architect-invoice"));
    await waitFor(() => expect(request).toHaveBeenCalledWith("POST", "/api/projects/9/certificats/42/send", { confirmWithoutArchitectInvoice: true }));
  });

  it("keeps Gmail failures visible, reconnect reachable, and check-now behavior intact", async () => {
    queryClient.setQueryData(["/api/dashboard/summary"], { ...summary, gmailLastPollStatus: "auth_revoked" });
    const request = vi.spyOn(api, "apiRequest").mockResolvedValue({ json: async () => ({ processed: 1, errors: 0 }) } as Response);
    mount();
    expect(screen.getByTestId("bar-gmail-status")).toHaveTextContent("needs attention");
    expect(screen.getByTestId("link-link-gmail-inbox")).toHaveAttribute("href", "/api/auth/link-gmail");
    expect(screen.getByTestId("badge-email-docs-need-attention")).toHaveTextContent("2");
    expect(screen.getByTestId("badge-gmail-stuck-messages")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("button-poll-gmail-now"));
    await waitFor(() => expect(request).toHaveBeenCalledWith("POST", "/api/gmail/poll"));
  });

  it("preserves stuck-message management endpoint and user ownership", async () => {
    const request = vi.spyOn(api, "apiRequest").mockResolvedValue({ json: async () => ({}) } as Response);
    mount();
    fireEvent.click(screen.getByTestId("link-gmail-stuck-messages"));
    const dialog = screen.getByTestId("dialog-stuck-gmail-messages");
    fireEvent.click(within(dialog).getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("POST", "/api/gmail/stuck-messages/stuck%2Ftest/skip", {
      userId: 1, reason: "Manually skipped by operator from dashboard",
    }));
  });

  it("surfaces a collapsed-source failure with retry rather than an all-clear", async () => {
    queryClient.removeQueries({ queryKey: ["/api/design-contracts/dashboard-actions"] });
    queryClient.setQueryDefaults(["/api/design-contracts/dashboard-actions"], { queryFn: async () => { throw new Error("Milestones unavailable"); } });
    mount();
    expect(await screen.findByText("Unable to load: Milestones unavailable")).toBeVisible();
    expect(disclosure("Design milestones awaiting invoice")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("shows persisted scan errors even when the summary last-poll status says success", () => {
    queryClient.setQueryData(["/api/gmail/status"], {
      ...health, pollHealth: { level: "error", ageMs: 10, message: "Persisted inbox scan failed." },
    });
    mount();
    expect(screen.getByTestId("text-gmail-health-warning")).toHaveTextContent("Persisted inbox scan failed.");
    expect(screen.getByTestId("bar-gmail-status")).toHaveTextContent("needs attention");
  });

  it.each([
    ["/api/gmail/status", "Gmail status unavailable"],
    ["/api/auth/user", "Inbox connection unavailable"],
    ["/api/certificats/unsent", "Dispatch unavailable"],
    ["/api/fees/outstanding", "Accounting unavailable"],
  ])("shows %s failures visibly even without opening supporting sections", async (path, message) => {
    queryClient.removeQueries({ queryKey: [path] });
    queryClient.setQueryDefaults([path], { queryFn: async () => { throw new Error(message); } });
    mount();
    expect(await screen.findByText(`Unable to load: ${message}`)).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(screen.queryByTestId("card-outstanding-fees-empty")).toBeNull();
  });

  it("shows summary failure and retry without claiming there are no projects", async () => {
    queryClient.removeQueries({ queryKey: ["/api/dashboard/summary"] });
    queryClient.setQueryDefaults(["/api/dashboard/summary"], { queryFn: async () => { throw new Error("Summary unavailable"); } });
    mount();
    expect(await screen.findByText("Unable to load: Summary unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(screen.queryByTestId("card-empty-projects")).toBeNull();
  });
});

it("supports keyboard disclosure controls and preserves mounted child state", async () => {
  function Editor() {
    const [text, setText] = useState("");
    return <input aria-label="Draft" value={text} onChange={(event) => setText(event.target.value)} />;
  }
  render(<DashboardDisclosure title="Editor" summary="Draft" defaultOpen><Editor /></DashboardDisclosure>);
  const user = userEvent.setup();
  const button = disclosure("Editor");
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Keep me" } });
  button.focus();
  await user.keyboard("{Enter}");
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByLabelText("Draft")).toHaveValue("Keep me");
  expect(screen.getByLabelText("Draft")).not.toBeVisible();
  await user.keyboard(" ");
  expect(screen.getByLabelText("Draft")).toBeVisible();
  expect(screen.getByLabelText("Draft")).toHaveValue("Keep me");
});
