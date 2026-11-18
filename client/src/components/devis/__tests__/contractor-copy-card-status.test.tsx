// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
vi.mock("../ContractorCopySend", () => ({ ContractorCopySend: () => <div>Existing confirmation flow</div> }));
import { ContractorCopyCardStatus, contractorCardState } from "../ContractorCopyCardStatus";
afterEach(cleanup);
const delivery = { id: 1, status: "sent", currentDocument: true, recipientEmail: "test@example.test", sentAt: "2026-11-18" };
describe("contractor copy card", () => {
  it("only shows green for successful current-document evidence", () => {
    expect(contractorCardState([delivery]).tone).toBe("green");
    expect(contractorCardState([{ ...delivery, currentDocument: false }]).label).toBe("Send signed copy to contractor");
    expect(contractorCardState([{ ...delivery, sentAt: null }]).tone).not.toBe("green");
  });
  it.each(["queued", "sending", "pending_pdf"])("does not mark %s sent", status => {
    expect(contractorCardState([{ ...delivery, status }]).label).toBe("Sending to contractor…");
  });
  it("surfaces uncertainty and failed resends instead of hiding them behind earlier success", () => {
    expect(contractorCardState([delivery, { ...delivery, id: 2, status: "failed" }]).tone).toBe("red");
    expect(contractorCardState([{ ...delivery, status: "reconciling" }]).label).toBe("Checking send result");
  });
  it("opens the existing flow without submitting or toggling the card", async () => {
    const toggle = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => ({ deliveries: [delivery] }) } } });
    render(<QueryClientProvider client={client}><div onClick={toggle}>
      <ContractorCopyCardStatus devisId={42} projectId={1} isSigned isArchived={false} />
    </div></QueryClientProvider>);
    fireEvent.click(await screen.findByText("Sent to contractor"));
    expect(screen.getByText("Existing confirmation flow")).toBeVisible();
    expect(toggle).not.toHaveBeenCalled();
    client.clear();
  });
  it("reports unavailable status rather than an unsent quotation when the query fails", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => { throw new Error("offline"); } } } });
    render(<QueryClientProvider client={client}><ContractorCopyCardStatus devisId={42} projectId={1} isSigned isArchived={false} /></QueryClientProvider>);
    expect(await screen.findByText("Contractor copy status unavailable")).toBeVisible();
    client.clear();
  });
});
