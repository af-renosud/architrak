import { createPortal } from "react-dom";
import { ArrowUpToLine, ArrowDownToLine } from "lucide-react";
import { useScrollNavigation } from "@/hooks/use-scroll-navigation";
import "./ScrollNavigation.css";

/** Contextual pair: the document by default, or the panel being read/edited.
 * Modal controls are portaled INSIDE the active content, never behind its
 * inert overlay or outside Radix's focus/dismissal scope. */
export function ScrollNavigation() {
  const state = useScrollNavigation();
  if (!state) return null;
  const { target, dialog, atTop, atBottom, dialogTop, dialogRight } = state;
  const scroll = (bottom: boolean) => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const top = bottom ? target.scrollHeight - target.clientHeight : 0;
    const options: ScrollToOptions = { top, behavior: reduced ? "instant" : "smooth" };
    if (target === document.scrollingElement || target === document.documentElement) {
      window.scrollTo(options);
    } else {
      target.scrollTo(options);
    }
  };
  const context = dialog ? "de la fenêtre" : target === document.scrollingElement || target === document.documentElement ? "de la page" : "du panneau";
  const topLabel = `Aller en haut ${context}`;
  const bottomLabel = `Aller en bas ${context}`;
  return createPortal(
    <div
      className="scroll-navigation"
      data-scroll-navigation=""
      data-document={dialog ? undefined : ""}
      role="group"
      aria-label={`Navigation ${context}`}
      style={dialog ? { position: "absolute", top: Math.max(12, dialogTop), right: dialogRight } : undefined}
    >
      <button type="button" title={topLabel} aria-label={topLabel} disabled={atTop} onClick={() => scroll(false)}>
        <ArrowUpToLine size={18} aria-hidden="true" />
      </button>
      <button type="button" title={bottomLabel} aria-label={bottomLabel} disabled={atBottom} onClick={() => scroll(true)}>
        <ArrowDownToLine size={18} aria-hidden="true" />
      </button>
    </div>,
    dialog ?? document.body,
  );
}
