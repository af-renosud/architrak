import { useId, useRef, useState } from "react";
import { Button, type ButtonProps } from "./button";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { ChevronDown, ChevronRight } from "lucide-react";
import "./blocked-action.css";

export interface ActionRequirement {
  id: string;
  message: string;
  kind?: "missing" | "waiting" | "technical" | "readonly";
  onResolve?: () => void;
  href?: string;
  linkLabel?: string;
}

/** Focus only after the owner has revealed its section/tab. Never changes a draft. */
export function focusActionTarget(selector: string, root: ParentNode = document) {
  const target = root.querySelector<HTMLElement>(selector);
  if (!target || target.closest("[hidden]")) return false;
  const hadTabIndex = target.hasAttribute("tabindex");
  if (!hadTabIndex) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  target.scrollIntoView?.({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  target.classList.add("blocked-action-target");
  window.setTimeout(() => {
    target.classList.remove("blocked-action-target");
    if (!hadTabIndex) target.removeAttribute("tabindex");
  }, 2800);
  return true;
}

export function RequirementList({ requirements, onNavigate }: { requirements: ActionRequirement[]; onNavigate?: () => void }) {
  return <ul className="text-xs leading-relaxed">
    {requirements.map(requirement => <li key={requirement.id}>
      <span className="font-medium">{requirement.kind === "technical" ? "Unavailable: " : requirement.kind === "waiting" ? "Waiting: " : requirement.kind === "readonly" ? "Read-only: " : ""}</span>
      {requirement.message}{" "}
      {requirement.onResolve && <button type="button" className="underline underline-offset-2 font-semibold" onClick={() => { onNavigate?.(); requirement.onResolve?.(); }}>{requirement.linkLabel ?? "Go to field"}</button>}
      {requirement.href && <a className="underline underline-offset-2 font-semibold" href={requirement.href}>{requirement.linkLabel ?? "Go to details"}</a>}
    </li>)}
  </ul>;
}

/** A blocked action is focusable and explains itself; only busy actions are disabled.
 * Do not queue/replay the supplied handler when requirements later become clear. */
export function BlockedAction({ requirements = [], actionLabel, disabled, onClick, children, ...props }: ButtonProps & {
  requirements?: ActionRequirement[]; actionLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const navigating = useRef(false);
  const id = useId();
  const blocked = requirements.length > 0;
  return <Popover open={open && blocked} onOpenChange={next => { if (blocked && !disabled) setOpen(next); }}>
    <PopoverTrigger asChild>
      <Button {...props} type="button" disabled={disabled} aria-disabled={blocked || undefined} data-blocked-action={blocked || undefined}
        aria-describedby={open && blocked ? id : undefined}
        onClick={event => {
          event.stopPropagation();
          if (disabled) return;
          if (blocked) { event.preventDefault(); setOpen(true); return; }
          onClick?.(event);
        }}>{children}</Button>
    </PopoverTrigger>
    {blocked && <PopoverContent id={id} className="blocked-action-help space-y-2" onClick={event => event.stopPropagation()}
      onCloseAutoFocus={event => { if (navigating.current) { event.preventDefault(); navigating.current = false; } }}>
      <p className="text-sm font-semibold">{actionLabel}</p>
      <RequirementList requirements={requirements} onNavigate={() => { navigating.current = true; setOpen(false); }} />
      <p className="text-[11px] text-muted-foreground">Nothing has been submitted. Resolve these items, then choose this action again.</p>
    </PopoverContent>}
  </Popover>;
}

export function ActionChecklist({ label, requirements, reviewLinks = [], collapsible = false }: { label: string; requirements: ActionRequirement[]; reviewLinks?: ActionRequirement[]; collapsible?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const visible = !collapsible || expanded;
  return <div className="blocked-action-checklist space-y-2" aria-label={label}>
    {collapsible ? <button type="button" className="flex w-full items-center gap-2 rounded-sm text-left text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-2"
      aria-expanded={expanded} aria-controls={contentId}
      onClick={event => { event.stopPropagation(); setExpanded(value => !value); }}>
      {expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
      <span>{label}</span>
      <span className="ml-auto text-[11px] font-normal text-muted-foreground">{expanded ? "Hide checklist" : "Show checklist"}</span>
    </button> : <p className="text-xs font-semibold">{label}</p>}
    <div id={contentId} hidden={!visible} className={visible ? "space-y-2" : undefined}>
    {requirements.length ? <RequirementList requirements={requirements} /> : <p className="text-xs text-muted-foreground">Local checks complete. The server verifies safeguards again when you submit.</p>}
    {reviewLinks.length > 0 && <div className="border-t border-border pt-2"><p className="text-[11px] text-muted-foreground mb-1">Review before sending</p><RequirementList requirements={reviewLinks} /></div>}
    </div>
  </div>;
}
