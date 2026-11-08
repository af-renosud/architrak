// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SignedPdfQuickLink } from "../SignedPdfQuickLink";

afterEach(cleanup);

describe("signed PDF header shortcut", () => {
  it("opens the retained signed copy separately without expanding the quotation", () => {
    const toggle = vi.fn();
    render(<TooltipProvider><div onClick={toggle}>
      <SignedPdfQuickLink devisId={49} available />
    </div></TooltipProvider>);
    const link = screen.getByRole("link", { name: "View signed PDF" });
    expect(link.getAttribute("href")).toBe("/api/devis/49/signed-pdf");
    expect(link.getAttribute("target")).toBe("_blank");
    fireEvent.click(link);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("does not offer a broken link when the signed copy is not yet stored", () => {
    render(<TooltipProvider><SignedPdfQuickLink devisId={49} available={false} /></TooltipProvider>);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
