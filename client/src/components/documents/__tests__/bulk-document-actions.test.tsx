// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkDocumentActions, BulkDocumentCheckbox } from "../BulkDocumentActions";
import { useBulkDocuments } from "@/hooks/use-bulk-documents";

afterEach(cleanup);

function Fixture({ execute, onRow = () => {} }: { execute: (id: number, reason: string) => Promise<unknown>; onRow?: () => void }) {
  const selection = useBulkDocuments({
    items: [{ id: 71, name: "Lot fenêtres", eligible: true }, { id: 72, name: "Lot toiture", eligible: true }, { id: 73, name: "Signed", eligible: false }],
    scope: "quotation:8", execute, onSettled: () => {},
  });
  return <><BulkDocumentActions selection={selection} action="Void" requireReason description="Records and PDFs are retained, not deleted." eligibilityHint="Drafts only" />
    <div onClick={onRow}><BulkDocumentCheckbox selection={selection} id={71} name="Lot fenêtres" eligible />
      <BulkDocumentCheckbox selection={selection} id={73} name="Signed" eligible={false} /></div></>;
}

describe("bulk action confirmation", () => {
  it("has accessible labels, stops row navigation, shows count and mixed selection, and requires a reason", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const row = vi.fn();
    render(<Fixture execute={execute} onRow={row} />);
    expect((screen.getByRole("checkbox", { name: "Select Signed" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Lot fenêtres" }));
    expect(row).not.toHaveBeenCalled();
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select all eligible documents shown" }).getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(screen.getByRole("button", { name: "Void selected" }));
    expect(screen.getByRole("heading", { name: "Void 1 document?" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Documents to process" }).textContent).toContain("Lot fenêtres");
    const confirm = screen.getByRole("button", { name: "Void 1 document" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: " Extraction rejected " } });
    fireEvent.click(confirm);
    await waitFor(() => expect(execute).toHaveBeenCalledWith(71, "Extraction rejected"));
    await waitFor(() => expect(screen.getByText("1 completed · 0 failed")).toBeTruthy());
  });

  it("lists exact per-record refusals and keeps failed selection available to retry", async () => {
    render(<Fixture execute={vi.fn().mockRejectedValue(new Error("409: signed evidence"))} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Lot fenêtres" }));
    fireEvent.click(screen.getByRole("button", { name: "Void selected" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Rejected extraction" } });
    fireEvent.click(screen.getByRole("button", { name: "Void 1 document" }));
    await waitFor(() => expect(screen.getByText("0 completed · 1 failed")).toBeTruthy());
    expect(screen.getByText("409: signed evidence")).toBeTruthy();
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select Lot fenêtres" }).getAttribute("aria-checked")).toBe("true");
  });
});
