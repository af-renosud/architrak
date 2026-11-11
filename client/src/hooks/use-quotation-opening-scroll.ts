import { useEffect, useRef } from "react";

/** Navigation owns scrolling; refreshed quotation data must not own it. */
export function useQuotationOpeningScroll(
  projectId: string,
  quotationId: number | null,
  ready: boolean,
  focusedCheckId: number | null,
) {
  const handled = useRef(false);
  useEffect(() => {
    handled.current = false;
  }, [projectId, quotationId, focusedCheckId]);

  useEffect(() => {
    if (!quotationId || focusedCheckId || !ready || handled.current) return;
    const cancel = () => {
      handled.current = true;
      window.clearTimeout(timer);
    };
    const timer = window.setTimeout(() => {
      const node = document.querySelector<HTMLElement>(`[data-testid="detail-devis-${quotationId}"]`);
      if (!node) return;
      handled.current = true;
      node.scrollIntoView?.({ behavior: "smooth", block: "start" });
    }, 100);
    // If the user starts working before the delayed jump, leave them alone.
    const events = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
    events.forEach(event => window.addEventListener(event, cancel, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach(event => window.removeEventListener(event, cancel));
    };
  }, [projectId, quotationId, ready, focusedCheckId]);
}
