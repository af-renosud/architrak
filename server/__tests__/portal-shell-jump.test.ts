import { describe, it, expect, vi } from "vitest";

// renderPortalShell builds a self-contained HTML page with inline JS — no
// build step. We verify Task #111's two essential bits live in that HTML:
//   1) the per-question "Voir page N" jump button template (with a stable
//      data-testid + data-jump-page payload), gated on pdfPageHint.
//   2) the click handler that mutates the embedded PDF iframe src to the
//      standard "#page=N" URL fragment honoured by Chrome/Safari/Firefox
//      built-in PDF viewers.
//
// Doing this as a string assertion against the rendered HTML keeps us free
// of a jsdom dev-dep just for one click handler — which the prior task
// review explicitly flagged as disproportionate. The data-payload path
// (lineMap → pdfPageHint flowing into the JSON endpoint) is covered by the
// integration test in devis-checks.integration.test.ts.

vi.mock("../storage", () => ({ storage: {} }));
vi.mock("../services/devis-checks", () => ({
  hashToken: (s: string) => s,
  resolveDevisCheckToken: vi.fn(),
  computeTokenExpiry: () => new Date(),
}));
vi.mock("../storage/object-storage", () => ({ getDocumentStream: vi.fn() }));

describe("renderPortalShell — click-to-jump-in-PDF (Task #111)", () => {
  it("includes the jump-button template gated on pdfPageHint and a non-null lineNumber", async () => {
    const { renderPortalShell } = await import("../routes/public-checks");
    const html = renderPortalShell({ mode: "live", token: "tok-abc-123" });

    // Conditional render: only when both pdfPageHint != null AND a line
    // number is present. General questions and missing-hint line items
    // do not get a jump button (no broken jump targets).
    expect(html).toContain("c.pdfPageHint != null && c.pdfPageHint >= 1 && c.lineNumber != null");
    // The button itself: stable testid + payload + French label.
    expect(html).toContain('data-jump-page="');
    expect(html).toContain('button-jump-page-');
    expect(html).toContain("Voir page ");
  });

  it("wires the click handler to mutate the iframe src to the standard #page=N fragment", async () => {
    const { renderPortalShell } = await import("../routes/public-checks");
    const html = renderPortalShell({ mode: "live", token: "tok-abc-123" });

    // The handler binds against any rendered jump button.
    expect(html).toContain('querySelectorAll("button[data-jump-page]")');
    // The payload is read from data-jump-page and fed into the URL fragment.
    expect(html).toContain('btn.getAttribute("data-jump-page")');
    expect(html).toContain('PDF_URL + "#page=" + page');
    // Side effect: the floating PDF panel is forced open so the contractor
    // sees the jump even if they hadn't toggled the panel yet.
    expect(html).toContain('panel.classList.add("open")');
  });

  it("works identically in architect preview mode (same template, different URLs)", async () => {
    const { renderPortalShell } = await import("../routes/public-checks");
    const html = renderPortalShell({ mode: "preview", devisId: 99 });
    // Preview gets the architect-side PDF endpoint — but the same jump glue
    // is in the rendered shell, so the architect can verify the jump
    // experience before sending the link to the contractor.
    expect(html).toContain("/api/devis/99/checks/portal-preview/pdf");
    expect(html).toContain('querySelectorAll("button[data-jump-page]")');
    expect(html).toContain('PDF_URL + "#page=" + page');
  });
});
