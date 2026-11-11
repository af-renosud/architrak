// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfPopoutViewer } from "../PdfPopoutViewer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { status: "finalised" } }),
}));
const viewer = (onClose: () => void) => <TooltipProvider>
  <PdfPopoutViewer devisId={42} devisCode="TEST" onClose={onClose} />
</TooltipProvider>;
let opener: HTMLButtonElement;
let editor: HTMLInputElement;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  sessionStorage.clear();
  opener = document.createElement("button");
  editor = document.createElement("input");
  document.body.append(opener, editor);
  opener.focus();
});
afterEach(() => { cleanup(); opener.remove(); editor.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("non-modal PDF focus", () => {
  it("yields to a compose modal and resumes without stealing its focus", async () => {
    const content = (open: boolean) => <>
      {viewer(vi.fn())}
      <Dialog open={open}><DialogContent aria-describedby={undefined}>
        <DialogTitle>Compose email</DialogTitle>
        <textarea aria-label="Message" />
      </DialogContent></Dialog>
    </>;
    const view = render(content(false));
    const pdf = screen.getByTestId("dialog-pdf-popout-42");
    await waitFor(() => expect(document.activeElement).toBe(pdf));
    view.rerender(content(true));
    const message = screen.getByLabelText("Message");
    message.focus();
    fireEvent.change(message, { target: { value: "A".repeat(3000) } });
    await waitFor(() => expect(pdf.inert).toBe(true));
    expect(pdf.style.zIndex).toBe("40");
    expect(pdf.style.pointerEvents).toBe("none");
    expect(document.activeElement).toBe(message);
    fireEvent.load(await screen.findByTestId("pdf-popout-iframe-42"));
    expect(document.activeElement).toBe(message);
    expect((message as HTMLTextAreaElement).value).toHaveLength(3000);
    view.rerender(content(false));
    await waitFor(() => expect(pdf.inert).toBe(false));
    expect(pdf.style.zIndex).toBe("60");
  });

  it("focuses once without scrolling and does not grab focus on parent refresh", async () => {
    const view = render(viewer(vi.fn()));
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    const openerFocus = vi.spyOn(opener, "focus");
    const dialogFocus = vi.spyOn(dialog, "focus");
    editor.focus();
    view.rerender(viewer(vi.fn()));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(editor);
    expect(openerFocus).not.toHaveBeenCalled();
    expect(dialogFocus).not.toHaveBeenCalled();
    view.unmount();
    expect(document.activeElement).toBe(editor);
  });
  it("does not steal focus when the PDF finishes loading", async () => {
    render(viewer(vi.fn()));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog")));
    const iframe = await screen.findByTestId("pdf-popout-iframe-42");
    editor.focus();
    fireEvent.load(iframe);
    expect(document.activeElement).toBe(editor);
  });
  it("uses the latest close callback for Escape and restores focus without scrolling", async () => {
    const oldClose = vi.fn();
    const newClose = vi.fn();
    const view = render(viewer(oldClose));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog")));
    view.rerender(viewer(newClose));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(oldClose).not.toHaveBeenCalled();
    expect(newClose).toHaveBeenCalledTimes(1);
    const focus = vi.spyOn(opener, "focus");
    view.unmount();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(opener);
  });
  it("leaves Escape in the line-item editor alone", async () => {
    const close = vi.fn();
    render(viewer(close));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("dialog")));
    editor.focus();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
  });
});
