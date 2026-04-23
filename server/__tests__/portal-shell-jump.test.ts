import { describe, it, expect, vi } from "vitest";

// renderPortalShell builds a self-contained HTML page with inline JS — no
// build step. We verify the essential bits live in that HTML:
//
// Task #111 (per-page jump):
//   1) the per-question "Voir page N" jump button template (with a stable
//      data-testid + data-jump-page payload), gated on pdfPageHint.
//   2) the click handler that opens the floating PDF panel and routes to
//      the (lazily loaded) pdf.js viewer — with a graceful iframe +
//      "#page=N" fallback if the CDN fails.
//
// Task #113 (per-line highlight):
//   3) the bbox payload travels on the jump button when present.
//   4) the pdf.js viewer is bundled and renders pages into canvases with
//      an absolutely-positioned overlay container.
//   5) jumpToPage draws a .pdf-highlight rectangle when given a bbox, and
//      degrades to scrollIntoView when the bbox is absent (page-level
//      fallback).
//
// Doing this as string assertions against the rendered HTML keeps us free
// of a jsdom dev-dep just for one click handler. The data-payload path
// (lineMap → pdfPageHint + pdfBbox flowing into the JSON endpoint) is
// covered by the integration test in devis-checks.integration.test.ts.

vi.mock("../storage", () => ({ storage: {} }));
vi.mock("../services/devis-checks", () => ({
  hashToken: (s: string) => s,
  resolveDevisCheckToken: vi.fn(),
  computeTokenExpiry: () => new Date(),
}));
vi.mock("../storage/object-storage", () => ({ getDocumentStream: vi.fn() }));

describe("renderPortalShell — click-to-jump-in-PDF (Task #111 + #113)", () => {
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

  it("attaches the per-line bbox payload to the jump button when one was captured (Task #113)", async () => {
    const { renderPortalShell } = await import("../routes/public-checks");
    const html = renderPortalShell({ mode: "live", token: "tok-abc-123" });

    // The bbox JSON travels alongside the jump button so the click handler
    // can paint a highlight rectangle over the page canvas. Bbox is gated
    // on c.pdfBbox truthiness so absent boxes do not emit the attribute.
    expect(html).toContain('data-jump-bbox="');
    expect(html).toContain('c.pdfBbox ? \' data-jump-bbox="\'');
  });

  it("wires the click handler to the pdf.js-backed viewer with bbox-aware jumping (Task #113)", async () => {
    const { renderPortalShell } = await import("../routes/public-checks");
    const html = renderPortalShell({ mode: "live", token: "tok-abc-123" });

    // The handler binds against any rendered jump button.
    expect(html).toContain('querySelectorAll("button[data-jump-page]")');
    // The payload is read from data-jump-page and the bbox is parsed from
    // the optional data-jump-bbox attribute.
    expect(html).toContain('btn.getAttribute("data-jump-page")');
    expect(html).toContain('btn.getAttribute("data-jump-bbox")');
    // Side effect: the floating PDF panel is forced open so the contractor
    // sees the jump even if they hadn't toggled the panel yet.
    expect(html).toContain('panel.classList.add("open")');
    // The handler delegates to jumpToPage(page, bbox), not direct iframe
    // src mutation — pdf.js drives the viewer.
    expect(html).toContain("jumpToPage(page, bbox)");
  });

  it("bundles the pdf.js viewer with a per-line highlight overlay (Task #113)", async () => {
    const { renderPortalShell } = await import("../routes/public-checks");
    const html = renderPortalShell({ mode: "live", token: "tok-abc-123" });

    // pdf.js is loaded lazily from cdnjs (legacy 3.x UMD build).
    expect(html).toContain("cdnjs.cloudflare.com/ajax/libs/pdf.js/");
    expect(html).toContain("pdf.min.js");
    expect(html).toContain("pdf.worker.min.js");
    // Pages are rendered into canvases inside a scrollable container.
    expect(html).toContain('id="pdfPages"');
    expect(html).toContain("page.render({ canvasContext");
    // The highlight rectangle is an absolutely-positioned overlay element
    // sized in % of the page wrapper — i.e. it tracks the rendered page
    // regardless of zoom/scale.
    expect(html).toContain("pdf-highlight");
    expect(html).toContain("(bbox.x * 100)");
    expect(html).toContain("(bbox.y * 100)");
    expect(html).toContain("(bbox.w * 100)");
    expect(html).toContain("(bbox.h * 100)");
  });

  it("degrades to a page-level scroll when no bbox is available (Task #111 fallback preserved)", async () => {
    const { renderPortalShell } = await import("../routes/public-checks");
    const html = renderPortalShell({ mode: "live", token: "tok-abc-123" });

    // No bbox → the page wrapper is scrolled into view; no highlight is
    // drawn. This is the Task #111 behaviour, preserved on top of pdf.js.
    expect(html).toContain('target.wrapper.scrollIntoView');
  });

  it("falls back to the native iframe + #page=N viewer when pdf.js fails to load (Task #113 resilience)", async () => {
    const { renderPortalShell } = await import("../routes/public-checks");
    const html = renderPortalShell({ mode: "live", token: "tok-abc-123" });

    // CDN blocked / offline / pdf.js global missing → switchToIframeFallback
    // routes the contractor to the browser's built-in PDF viewer instead
    // of leaving the panel blank.
    expect(html).toContain("switchToIframeFallback");
    expect(html).toContain('PDF_URL + "#page=" + jumpPage');
    expect(html).toContain('class="pdf-fallback"');
  });

  it("works identically in architect preview mode (same template, different URLs)", async () => {
    const { renderPortalShell } = await import("../routes/public-checks");
    const html = renderPortalShell({ mode: "preview", devisId: 99 });
    // Preview gets the architect-side PDF endpoint — but the same jump glue
    // is in the rendered shell, so the architect can verify the jump
    // experience before sending the link to the contractor.
    expect(html).toContain("/api/devis/99/checks/portal-preview/pdf");
    expect(html).toContain('querySelectorAll("button[data-jump-page]")');
    expect(html).toContain("jumpToPage(page, bbox)");
    expect(html).toContain("pdf-highlight");
  });
});
