// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeeVisibilityRecord } from "@shared/fee-visibility";
import { FeeHistory, FeeVisibilityAction } from "../FeeVisibility";
import { FeeDisclosure } from "../FeeDisclosure";

const mutation = vi.hoisted(() => ({ mutate: vi.fn(), reset: vi.fn(), error: null as Error | null, isPending: false }));
vi.mock("@/hooks/use-fee-visibility", () => ({ useChangeFeeVisibility: () => mutation, useFeeVisibility: vi.fn() }));
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); mutation.error = null; });
const record: FeeVisibilityRecord = { kind: "entry", id: 27, archived: false, archivedAt: null, reason: null, blockedReason: null };

describe("fee disclosures", () => {
  it("starts collapsed and collapse-all preserves an unsaved draft", () => {
    const view = (collapseVersion: number) => <FeeDisclosure collapseVersion={collapseVersion} summary="Fee details"><input aria-label="Unsaved accounting reference" defaultValue="" /></FeeDisclosure>;
    const { container, rerender } = render(view(0));
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    details.open = true;
    const input = screen.getByLabelText("Unsaved accounting reference") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Draft reference 83" } });
    rerender(view(1));
    expect(details.open).toBe(false);
    expect(input.value).toBe("Draft reference 83");
  });
});
describe("audited visibility controls", () => {
  it("requires a nonblank reason and sends archive, never delete", () => {
    render(<FeeVisibilityAction projectId="8" record={record} />);
    fireEvent.click(screen.getByText("Archive entry"));
    const confirm = screen.getByText("Confirm archive") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "Reconciled with original invoice" } });
    fireEvent.click(confirm);
    expect(mutation.mutate).toHaveBeenCalledWith({ kind: "entry", id: 27, action: "archive", reason: "Reconciled with original invoice" }, expect.any(Object));
  });
  it("explains server blockers and disables archive", () => {
    render(<FeeVisibilityAction projectId="8" record={{ ...record, blockedReason: "Original invoice evidence incomplete" }} />);
    expect((screen.getByText("Archive entry") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Cannot archive: Original invoice evidence incomplete/)).toBeTruthy();
  });
  it("requires a reason for restore too, and shows server errors", () => {
    mutation.error = new Error("Visibility service unavailable");
    render(<FeeVisibilityAction projectId="8" record={{ ...record, archived: true, reason: "Completed" }} />);
    fireEvent.click(screen.getByText("Restore entry"));
    expect((screen.getByText("Confirm restore") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Visibility service unavailable");
  });
  it("does not guess archive state for a missing visibility record", () => {
    render(<FeeVisibilityAction projectId="8" />);
    expect(screen.getByText("Visibility unavailable")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("renders audited actor, reason and action instead of inferred history", () => {
    render(<FeeHistory events={[{ id: 6, kind: "fee", recordId: 11, action: "restore", reason: "New original invoice received", actor: "Camille Martin", createdAt: "2026-02-17T08:24:00Z" }]} />);
    expect(screen.getByText("Restored fee #11")).toBeTruthy();
    expect(screen.getByText("New original invoice received")).toBeTruthy();
    expect(screen.getByText(/Camille Martin/)).toBeTruthy();
  });
});
