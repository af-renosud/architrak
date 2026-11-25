// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ReplacementReviewPanel } from "../QuotationApprovalReview";

vi.mock("@/lib/queryClient", () => ({ apiRequest: vi.fn() }));
afterEach(cleanup);
const l = (id: number, description: string, totalHt = "10.00") => ({ id, lineNumber: id, description, totalHt });
describe("replacement review summary", () => {
  it("lists counts, shows changed and new items, and collapses unchanged ones", () => {
    const onLocate = vi.fn();
    render(<ReplacementReviewPanel onLocate={onLocate} summary={{
      previousId: 55, previousLabel: "CZ.1.ROOF",
      unchanged: [l(1, "Dépose"), l(2, "Nettoyage")], figuresChanged: [{ ...l(3, "Tuiles\nterre cuite", "250.00"), previousTotalHt: "200.00" }],
      added: [l(4, "Gouttière")], removed: [l(9, "Ancien poste")],
    }} />);
    expect(screen.getByText("2 carried over unchanged · 1 figures changed · 1 new · 1 removed")).toBeInTheDocument();
    expect(screen.getByText(/was 200.00 HT, now 250.00 HT/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Item 4 · Gouttière" }));
    expect(onLocate).toHaveBeenCalledWith("line-4", { section: "translation", rowId: 4, field: "descriptionEn" });
    expect(screen.getByText("Item 1 · Dépose").closest("details")).not.toHaveAttribute("open");
  });
});
