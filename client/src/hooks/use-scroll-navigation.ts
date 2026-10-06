import { useEffect, useState } from "react";

export interface ScrollNavigationState {
  target: HTMLElement;
  dialog: HTMLElement | null;
  atTop: boolean;
  atBottom: boolean;
  dialogTop: number;
  dialogRight: number;
}

const CONTROL = "[data-scroll-navigation]";
const MODAL = '[role="dialog"], [role="alertdialog"]';
const EXCLUDED = '#app-sidebar, [role="menu"], [role="listbox"], [data-scroll-navigation-ignore]';
const LIMIT = 2; // Browser rounding and fractional zoom.

/** One initial discovery; later only changed subtrees are inspected. Scroll
 * events measure cached candidates, never query the whole DOM. */
export function useScrollNavigation() {
  const [state, setState] = useState<ScrollNavigationState | null>(null);

  useEffect(() => {
    const root = document.scrollingElement as HTMLElement || document.documentElement;
    const candidates = new Set<HTMLElement>();
    const dialogs = new Set<HTMLElement>();
    const observed = new Set<Element>();
    let preferred: HTMLElement | null = null;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const visible = (element: HTMLElement) => {
      if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0
        && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
    };
    const scrollable = (element: HTMLElement) =>
      element.clientHeight > 0 && element.scrollHeight - element.clientHeight > LIMIT;
    const measure = () => {
      frame = 0;
      if (disposed) return;
      const dialog = Array.from(dialogs).filter(visible).at(-1) ?? null;
      const eligible = Array.from(candidates).filter(element =>
        visible(element) && element.clientHeight >= 120 && scrollable(element)
        && (dialog ? dialog.contains(element) : !!element.closest("[data-scroll-navigation-scope]"))
      );
      const preferredTarget = preferred && eligible.includes(preferred) ? preferred : null;
      const target = preferredTarget
        ?? (dialog && eligible.includes(dialog) ? dialog : null)
        ?? (!dialog && scrollable(root) ? root : null)
        ?? eligible.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0];
      if (!target) {
        setState(previous => previous === null ? previous : null);
        return;
      }
      const rect = dialog?.getBoundingClientRect();
      const next: ScrollNavigationState = {
        target, dialog,
        atTop: target.scrollTop <= LIMIT,
        atBottom: target.scrollTop >= target.scrollHeight - target.clientHeight - LIMIT,
        // Dialogs are transformed containing blocks. Keep an absolute, zero-layout
        // footprint inside their focus scope, pinned to their visible scrollport.
        dialogTop: dialog ? dialog.scrollTop + Math.min(dialog.clientHeight, window.innerHeight - Math.max(0, rect!.top)) - 108 : 0,
        dialogRight: dialog ? Math.max(12, rect!.right - window.innerWidth + 12) : 0,
      };
      setState(previous => previous && Object.keys(next).every(key =>
        previous[key as keyof ScrollNavigationState] === next[key as keyof ScrollNavigationState]
      ) ? previous : next);
    };
    const schedule = () => {
      if (!frame && !disposed) frame = window.requestAnimationFrame(measure);
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    const observe = (element: Element) => {
      if (!observed.has(element)) {
        observed.add(element);
        resize?.observe(element);
      }
    };
    const inspect = (element: HTMLElement) => {
      if (element.closest(CONTROL)) return;
      if (element.matches(MODAL)) dialogs.add(element);
      if (element.closest(EXCLUDED)) return;
      const style = getComputedStyle(element);
      if (/(auto|scroll|overlay)/.test(style.overflowY) || element.hasAttribute("data-radix-scroll-area-viewport")) {
        candidates.add(element);
        observe(element);
        Array.from(element.children).forEach(observe);
      } else {
        candidates.delete(element);
      }
    };
    const discover = (element: HTMLElement) => {
      inspect(element);
      element.querySelectorAll<HTMLElement>("*").forEach(inspect);
    };
    discover(document.body);
    observe(document.body);
    observe(root);
    const pending = new Set<HTMLElement>();
    const mutations = new MutationObserver(records => {
      for (const record of records) {
        const element = record.target instanceof HTMLElement ? record.target : record.target.parentElement;
        if (!element || element.closest(CONTROL)) continue;
        if (record.type === "attributes") pending.add(element);
        record.addedNodes.forEach(node => { if (node instanceof HTMLElement) pending.add(node); });
      }
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        pending.forEach(element => { if (element.isConnected) discover(element); });
        pending.clear();
        candidates.forEach(element => { if (!element.isConnected) candidates.delete(element); });
        dialogs.forEach(element => { if (!element.isConnected) dialogs.delete(element); });
        observed.forEach(element => {
          if (!element.isConnected) {
            resize?.unobserve(element);
            observed.delete(element);
          }
        });
        // New direct children can resize without subsequent DOM mutations.
        candidates.forEach(element => Array.from(element.children).forEach(observe));
        schedule();
      }, 80);
    });
    mutations.observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "inert", "aria-hidden", "data-state", "role"],
    });
    const interact = (event: Event) => {
      // Lucide SVG/path targets are Elements, not HTMLElements. Guard controls
      // before narrowing so an icon press cannot reset the selected panel.
      if (event.target instanceof Element && event.target.closest(CONTROL)) return;
      const element = event.target instanceof HTMLElement ? event.target : null;
      let ancestor = element;
      let nextPreferred: HTMLElement | null = null;
      while (ancestor) {
        if (candidates.has(ancestor) && scrollable(ancestor)) {
          nextPreferred = ancestor;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      // Keep the panel selected while the pointer travels to the floating
      // controls. An explicit outside click/focus or document scroll resets it.
      if (event.type === "pointerover" && !nextPreferred) return;
      preferred = nextPreferred;
      schedule();
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof HTMLElement && candidates.has(event.target)) preferred = event.target;
      else if (event.target === document || event.target === root) preferred = null;
      schedule();
    };
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("pointerover", interact, { passive: true });
    document.addEventListener("pointerdown", interact, { passive: true });
    document.addEventListener("focusin", interact);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    schedule();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      clearTimeout(timer);
      mutations.disconnect();
      resize?.disconnect();
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerover", interact);
      document.removeEventListener("pointerdown", interact);
      document.removeEventListener("focusin", interact);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    };
  }, []);
  return state;
}
