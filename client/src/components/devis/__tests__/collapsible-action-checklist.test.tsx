// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActionChecklist } from "@/components/ui/blocked-action";

afterEach(cleanup);

describe("collapsible quotation checklist", () => {
  it("starts closed, expands and preserves guidance actions, then closes again", () => {
    const resolve = vi.fn();
    render(<ActionChecklist collapsible label="Before sending for signature"
      requirements={[{ id: "lot", message: "Lot missing", onResolve: resolve, linkLabel: "Go to lot" }]}
      reviewLinks={[{ id: "translation", message: "Review translation" }]} />);
    const toggle = screen.getByRole("button", { name: /Before sending for signature/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Go to lot" })).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Go to lot" }));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Review translation").closest("[hidden]")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: "Go to lot" })).toBeNull();
  });

  it("leaves other checklists expanded by default", () => {
    render(<ActionChecklist label="Other checklist"
      requirements={[{ id: "contact", message: "Contact missing", onResolve: vi.fn(), linkLabel: "Go to contact" }]} />);
    expect(screen.getByRole("button", { name: "Go to contact" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show checklist/ })).toBeNull();
  });
});
