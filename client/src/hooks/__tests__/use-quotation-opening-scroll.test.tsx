// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuotationOpeningScroll } from "../use-quotation-opening-scroll";

const scroll = vi.fn();
const initial = { project: "12", id: 42 as number | null, ready: true, check: null as number | null };
function mount(props = initial) {
  return renderHook(p => useQuotationOpeningScroll(p.project, p.id, p.ready, p.check), { initialProps: props });
}
beforeEach(() => {
  vi.useFakeTimers();
  scroll.mockReset();
  document.body.innerHTML = '<div data-testid="detail-devis-42"></div><div data-testid="detail-devis-43"></div>';
  document.querySelectorAll("div").forEach(node => { node.scrollIntoView = scroll; });
});
afterEach(() => { cleanup(); vi.useRealTimers(); document.body.innerHTML = ""; });
const tick = () => act(() => { vi.advanceTimersByTime(150); });

describe("quotation opening scroll", () => {
  it("scrolls once, not on refresh or readiness changes", () => {
    const hook = mount();
    tick();
    hook.rerender({ ...initial });
    tick();
    hook.rerender({ ...initial, ready: false });
    hook.rerender({ ...initial, ready: true });
    tick();
    expect(scroll).toHaveBeenCalledTimes(1);
  });
  it("waits for async content, including a revealed void quotation", () => {
    const hook = mount({ ...initial, ready: false });
    tick();
    expect(scroll).not.toHaveBeenCalled();
    hook.rerender(initial);
    tick();
    expect(scroll).toHaveBeenCalledTimes(1);
  });
  it("allows a new navigation, including returning to an earlier quotation", () => {
    const hook = mount();
    tick();
    hook.rerender({ ...initial, id: 43 });
    tick();
    hook.rerender(initial);
    tick();
    expect(scroll).toHaveBeenCalledTimes(3);
  });
  it("leaves specific check deep links in control of their own scroll", () => {
    mount({ ...initial, check: 7 });
    tick();
    expect(scroll).not.toHaveBeenCalled();
  });
  it.each(["wheel", "pointerdown", "keydown", "touchmove"])("cancels a pending jump on %s", event => {
    const hook = mount();
    act(() => { window.dispatchEvent(new Event(event)); });
    tick();
    hook.rerender({ ...initial });
    tick();
    expect(scroll).not.toHaveBeenCalled();
  });
  it("cleans up pending navigation on unmount", () => {
    const hook = mount();
    hook.unmount();
    tick();
    expect(scroll).not.toHaveBeenCalled();
  });
});
