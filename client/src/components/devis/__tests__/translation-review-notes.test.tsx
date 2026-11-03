// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TranslationReviewNotes } from "../TranslationReviewNotes";

afterEach(cleanup);
describe("internal translation reference notes", () => {
  it("updates from the source without copying or editing note content", () => {
    const { rerender } = render(<TranslationReviewNotes lineItemId={7} note="Original note" checks={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Notes \/ questions \(1\)/ }));
    rerender(<TranslationReviewNotes lineItemId={7} note="Updated note" checks={[
      { id: 4, devisId: 1, lineItemId: 7, query: "Historical contractor question", origin: "line_item", status: "resolved" },
    ]} />);
    expect(screen.queryByText("Original note")).toBeNull();
    expect(screen.getByText("Updated note")).toBeTruthy();
    expect(screen.getByText("Contractor question · Resolved")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Notes \/ questions \(2\)/ })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    rerender(<TranslationReviewNotes lineItemId={7} note=" " checks={[]} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("renders note markup as plain text, not executable HTML", () => {
    const text = '<img src=x onerror="alert(1)">';
    const { container } = render(<TranslationReviewNotes lineItemId={7} note={text} checks={[]} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(text)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});
