// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ScrollNavigation } from "../ScrollNavigation";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

let documentHeight = 500;
let reduced = false;
let resizeCallback: (() => void) | undefined;
const root = document.documentElement;
const down = () => screen.getByRole("button", { name: /Aller en bas/ });
const up = () => screen.getByRole("button", { name: /Aller en haut/ });
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(120); }); };
function dimensions(element: HTMLElement, height = 1100, client = 300) {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, value: client },
    clientWidth: { configurable: true, value: 600 },
  });
  return vi.spyOn(element, "scrollTo").mockImplementation(() => {});
}

beforeEach(() => {
  vi.useFakeTimers();
  documentHeight = 500;
  reduced = false;
  root.scrollTop = 0;
  Object.defineProperties(document, { scrollingElement: { configurable: true, value: root } });
  Object.defineProperties(root, {
    scrollHeight: { configurable: true, get: () => documentHeight },
    clientHeight: { configurable: true, value: 500 },
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resizeCallback = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 1));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced })));
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON() {},
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("global scroll navigation", () => {
  it("hides on short pages, detects resized content, disables boundaries and respects reduced motion", async () => {
    render(<ScrollNavigation />);
    await flush();
    expect(screen.queryByRole("group")).toBeNull();
    documentHeight = 1900;
    act(() => resizeCallback?.());
    await flush();
    expect(up()).toBeDisabled();
    expect(down()).toBeEnabled();
    fireEvent.click(down());
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 1400, behavior: "smooth" });
    root.scrollTop = 1400;
    fireEvent.scroll(document);
    await flush();
    expect(down()).toBeDisabled();
    reduced = true;
    fireEvent.click(up());
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "instant" });
    root.scrollTop = 680;
    fireEvent.scroll(document);
    await flush();
    expect(up()).toBeEnabled();
    expect(down()).toBeEnabled();
  });

  it("targets nested translation/editor panels on focus, leaves the document alone and tracks their limits", async () => {
    documentHeight = 1700;
    const view = render(<><main data-scroll-navigation-scope=""><section style={{ overflowY: "auto" }} data-testid="editor"><textarea aria-label="Translation" /></section></main><ScrollNavigation /></>);
    const panel = screen.getByTestId("editor");
    const scroll = dimensions(panel);
    await flush();
    fireEvent.focus(screen.getByLabelText("Translation"));
    await flush();
    // Moving across the page to reach the buttons must not deselect the panel.
    fireEvent.pointerOver(view.container.querySelector("main")!);
    await flush();
    expect(down()).toHaveAccessibleName("Aller en bas du panneau");
    fireEvent.click(down());
    expect(scroll).toHaveBeenCalledWith({ top: 800, behavior: "smooth" });
    expect(window.scrollTo).not.toHaveBeenCalled();
    panel.scrollTop = 800;
    fireEvent.scroll(panel);
    await flush();
    expect(down()).toBeDisabled();
    view.rerender(<><main data-scroll-navigation-scope=""><p>New route</p></main><ScrollNavigation /></>);
    await flush();
    expect(down()).toHaveAccessibleName("Aller en bas de la page");
  });

  it("discovers newly mounted panels, ignores short menus, hides when content shrinks", async () => {
    const view = render(<><main data-scroll-navigation-scope="" /><ScrollNavigation /></>);
    await flush();
    view.rerender(<><main data-scroll-navigation-scope=""><div data-testid="panel" style={{ overflowY: "auto" }}><p>Long specification</p></div><div role="listbox" style={{ overflowY: "auto" }} /></main><ScrollNavigation /></>);
    const panel = screen.getByTestId("panel");
    dimensions(panel);
    await flush();
    expect(down()).toHaveAccessibleName("Aller en bas du panneau");
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 300 });
    act(() => resizeCallback?.());
    await flush();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("preserves the selected panel when an arrow SVG is pressed before a delayed click", async () => {
    documentHeight = 1700;
    render(<><main data-scroll-navigation-scope=""><section style={{ overflowY: "auto" }} data-testid="editor"><textarea aria-label="Translation" /></section></main><ScrollNavigation /></>);
    const panel = screen.getByTestId("editor");
    const scroll = dimensions(panel);
    await flush();
    fireEvent.focus(screen.getByLabelText("Translation"));
    await flush();
    const icon = down().querySelector("svg")!;
    fireEvent.pointerDown(icon);
    // Let the scheduled animation frame run before releasing the pointer.
    await flush();
    expect(down()).toHaveAccessibleName("Aller en bas du panneau");
    fireEvent.pointerUp(icon);
    fireEvent.click(icon);
    expect(scroll).toHaveBeenCalledWith({ top: 800, behavior: "smooth" });
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("portals into Radix modal content, supports nested panels without dismissal and restores the page on close", async () => {
    documentHeight = 1500;
    const onOpenChange = vi.fn();
    const view = render(<><main data-scroll-navigation-scope="" /><Dialog open onOpenChange={onOpenChange}><DialogContent aria-describedby={undefined}><DialogTitle>Specifications</DialogTitle><div data-testid="dialog-editor" style={{ overflowY: "auto" }}>Long bilingual specification</div></DialogContent></Dialog><ScrollNavigation /></>);
    const panel = screen.getByTestId("dialog-editor");
    const scroll = dimensions(panel);
    await flush();
    expect(screen.getByRole("dialog")).toContainElement(down());
    fireEvent.pointerDown(down());
    fireEvent.click(down());
    expect(scroll).toHaveBeenCalledWith({ top: 800, behavior: "smooth" });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(window.scrollTo).not.toHaveBeenCalled();
    down().focus();
    expect(down()).toHaveFocus();
    view.rerender(<><main data-scroll-navigation-scope="" /><ScrollNavigation /></>);
    await flush();
    expect(down()).toHaveAccessibleName("Aller en bas de la page");
    expect(down().closest('[role="dialog"]')).toBeNull();
  });

  it("remeasures text changes and window resize without rescanning the DOM on scroll", async () => {
    const view = render(<><main data-scroll-navigation-scope="">Short document</main><ScrollNavigation /></>);
    await flush();
    documentHeight = 1300;
    view.container.querySelector("main")!.firstChild!.textContent = "Expanded bilingual document";
    await flush();
    expect(down()).toBeEnabled();
    const scan = vi.spyOn(document.body, "querySelectorAll");
    root.scrollTop = 800;
    fireEvent.scroll(document);
    await flush();
    expect(scan).not.toHaveBeenCalled();
    expect(down()).toBeDisabled();
    documentHeight = 500;
    fireEvent(window, new Event("resize"));
    await flush();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("uses a scrolling dialog itself and suppresses background controls for a short modal", async () => {
    documentHeight = 1800;
    const view = render(<><main data-scroll-navigation-scope="" /><div role="alertdialog" data-testid="modal" style={{ overflowY: "auto", position: "fixed" }}>Long confirmation</div><ScrollNavigation /></>);
    const modal = screen.getByTestId("modal");
    const scroll = dimensions(modal);
    await flush();
    expect(modal).toContainElement(down());
    fireEvent.click(down());
    expect(scroll).toHaveBeenCalled();
    Object.defineProperty(modal, "scrollHeight", { configurable: true, value: 300 });
    act(() => resizeCallback?.());
    await flush();
    expect(screen.queryByRole("group")).toBeNull();
    view.unmount();
    fireEvent.scroll(document);
    await flush();
    expect(screen.queryByRole("group")).toBeNull();
  });
});
