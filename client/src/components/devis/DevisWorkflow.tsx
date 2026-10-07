import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { TabsContent } from "@/components/ui/tabs";
import { initialWorkflowGroup, workflowGroups, workflowIsOpen, workflowTarget, type WorkflowChoices, type WorkflowGroup } from "./devis-workflow-model";
import "./devis-workflow.css";

const labels: Record<WorkflowGroup, string> = {
  review: "Review source", prepare: "Prepare package", send: "Send & sign", after: "After signing",
};
const DetailVisibleContext = createContext(true);
const WorkflowContext = createContext<{
  devisId: number; initial: WorkflowGroup; choices: WorkflowChoices;
  choose: (group: WorkflowGroup, open: boolean) => void;
  jump: (group: WorkflowGroup) => void;
} | null>(null);

/** Mount on the first visit, then hide without tearing down draft/save owners. */
export function VisitedDetail({ open, children, className = "", onReveal }: { open: boolean; children: ReactNode; className?: string; onReveal?: () => void }) {
  const parentVisible = useContext(DetailVisibleContext);
  const visited = useRef(open);
  const body = useRef<HTMLDivElement>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const seenErrors = useRef(new Set<string>());
  const visible = useRef(open);
  visible.current = open;
  const reveal = useRef(onReveal);
  reveal.current = onReveal;
  if (open) visited.current = true;
  useEffect(() => {
    if (!body.current) return;
    const scan = () => {
      const messages = Array.from(body.current!.querySelectorAll<HTMLElement>('[role="alert"], [data-workflow-attention]')).map(node => node.textContent?.trim() ?? "").filter(Boolean);
      const unique = Array.from(new Set(messages));
      setErrors(previous => JSON.stringify(previous) === JSON.stringify(unique) ? previous : unique);
      const newError = Array.from(body.current!.querySelectorAll<HTMLElement>('[role="alert"]')).some(node => {
        const message = node.textContent?.trim();
        return message && !seenErrors.current.has(message);
      });
      unique.forEach(message => seenErrors.current.add(message));
      if (newError && !visible.current) reveal.current?.();
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(body.current, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [open]);
  return visited.current ? <>
    {!open && errors.length > 0 && <div className="devis-workflow__attention" aria-label="Collapsed quotation attention">
      {errors.map(error => <button type="button" key={error} disabled={!onReveal} onClick={() => reveal.current?.()}>{error}</button>)}
    </div>}
    <DetailVisibleContext.Provider value={parentVisible && open}>
      <div ref={body} hidden={!open} className={`devis-visited-detail ${className}`}>{children}</div>
    </DetailVisibleContext.Provider>
  </> : null;
}

export function PreservedTabsContent({ activeTab, value, className, children }: {
  activeTab: string; value: string; className?: string; children: ReactNode;
}) {
  const parentVisible = useContext(DetailVisibleContext);
  const visited = useRef(activeTab === value);
  if (activeTab === value) visited.current = true;
  return visited.current ? <DetailVisibleContext.Provider value={parentVisible && activeTab === value}>
    <TabsContent forceMount hidden={activeTab !== value} value={value}
      data-workflow-tab={value} className={`devis-preserved-tab ${className ?? ""}`}>{children}</TabsContent>
  </DetailVisibleContext.Provider> : null;
}

export function useWorkflowSectionVisible(group: WorkflowGroup) {
  const workflow = useContext(WorkflowContext);
  const detailVisible = useContext(DetailVisibleContext);
  return detailVisible && (!workflow || workflowIsOpen(group, workflow.initial, workflow.choices));
}

/** Status stays outside disclosures. A newly failed operation reveals its
 * recovery surface once, not on every refetch of the same failed payload. */
export function WorkflowNotice({ group, message, error = false, onRetry, tab }: {
  group: WorkflowGroup; message: string; error?: boolean; onRetry?: () => void; tab?: string;
}) {
  const workflow = useContext(WorkflowContext);
  const jump = useRef(workflow?.jump);
  jump.current = workflow?.jump;
  const reveal = () => {
    jump.current?.(group);
    if (tab) requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("architrak:workflow-tab", { detail: { devisId: workflow?.devisId, tab } })));
  };
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  useEffect(() => { if (error) revealRef.current(); }, [error, group, message]);
  return <div className="text-[11px] text-amber-800" role={error ? "alert" : undefined} data-workflow-attention>
    <button type="button" className="text-left underline underline-offset-2" onClick={reveal}>{message}</button>
    {onRetry && <button type="button" className="ml-3 underline underline-offset-2" onClick={onRetry}>Retry status</button>}
  </div>;
}

export function DevisWorkflow({ devisId, stage, status, children }: {
  devisId: number; stage?: string | null; status?: string | null; children: ReactNode;
}) {
  // Deliberately seed once. A refreshed stage must not steal focus or remount an
  // editor. The user can jump to the next stage explicitly.
  const [initial] = useState(() => initialWorkflowGroup(stage, status));
  const [choices, setChoices] = useState<WorkflowChoices>({});
  const choose = (group: WorkflowGroup, open: boolean) => setChoices(previous => ({ ...previous, [group]: open }));
  const jump = (group: WorkflowGroup) => {
    choose(group, true);
    requestAnimationFrame(() => {
      const heading = document.getElementById(`workflow-${devisId}-${group}-heading`);
      heading?.scrollIntoView?.({ block: "nearest" });
      heading?.focus();
    });
  };
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  useEffect(() => {
    const revealLink = () => {
      const params = new URLSearchParams(window.location.search);
      if (Number(params.get("devis")) !== devisId) return;
      const target = workflowTarget(window.location.search);
      if (target) jumpRef.current(target);
    };
    revealLink();
    const signing = (event: Event) => {
      const detail = (event as CustomEvent<{ devisId: number; workflowReplay?: boolean }>).detail;
      if (detail?.devisId !== devisId || detail.workflowReplay) return;
      jumpRef.current("send");
      // The signing panel can still be lazy-unmounted on the first send jump.
      // Replay after React commits so its existing send-dialog listener receives it.
      requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("architrak:open-signing-send", {
        detail: { ...detail, workflowReplay: true },
      })));
    };
    window.addEventListener("popstate", revealLink);
    window.addEventListener("architrak:open-signing-send", signing);
    const reveal = (event: Event) => {
      const detail = (event as CustomEvent<{ devisId: number; group: WorkflowGroup }>).detail;
      if (detail?.devisId === devisId && workflowGroups.includes(detail.group)) jumpRef.current(detail.group);
    };
    window.addEventListener("architrak:workflow-jump", reveal);
    return () => {
      window.removeEventListener("popstate", revealLink);
      window.removeEventListener("architrak:open-signing-send", signing);
      window.removeEventListener("architrak:workflow-jump", reveal);
    };
  }, [devisId]);
  return <WorkflowContext.Provider value={{ devisId, initial, choices, choose, jump }}>
    <div className="devis-workflow">
      <nav className="devis-workflow__tools" aria-label="Quotation workflow">
        <span>Quotation workflow · independent sections</span>
        <button type="button" onClick={() => setChoices(Object.fromEntries(workflowGroups.map(group => [group, false])))}>Collapse all</button>
        <button type="button" onClick={() => setChoices(Object.fromEntries(workflowGroups.map(group => [group, true])))}>Expand all</button>
        <select aria-label="Jump to quotation section" value="" onChange={event => jump(event.target.value as WorkflowGroup)}>
          <option value="" disabled>Jump to…</option>
          {workflowGroups.map(group => <option key={group} value={group}>{labels[group]}</option>)}
        </select>
      </nav>
      {children}
    </div>
  </WorkflowContext.Provider>;
}

export function WorkflowSection({ group, summary, children }: { group: WorkflowGroup; summary: ReactNode; children: ReactNode }) {
  const workflow = useContext(WorkflowContext);
  if (!workflow) throw new Error("WorkflowSection must be inside DevisWorkflow");
  const { devisId, initial, choices, choose, jump } = workflow;
  const open = workflowIsOpen(group, initial, choices);
  const visited = useRef(open);
  if (open) visited.current = true;
  const body = useRef<HTMLDivElement>(null);
  const [attention, setAttention] = useState<string[]>([]);
  const seen = useRef(new Set<string>());
  const actions = useRef({ choose, jump });
  actions.current = { choose, jump };
  const revealTarget = (target: HTMLElement | undefined) => {
    actions.current.jump(group);
    const tab = target?.closest<HTMLElement>("[data-workflow-tab]")?.dataset.workflowTab;
    if (tab) window.dispatchEvent(new CustomEvent("architrak:workflow-tab", { detail: { devisId, tab } }));
    requestAnimationFrame(() => {
      target?.setAttribute("tabindex", "-1");
      target?.focus();
      target?.scrollIntoView?.({ block: "nearest" });
    });
  };
  const revealTargetRef = useRef(revealTarget);
  revealTargetRef.current = revealTarget;
  useLayoutEffect(() => {
    if (!visited.current || !body.current) return;
    // Existing feature components retain ownership of their queries and save
    // queues. Mirror their inline alerts outside hidden content, without adding
    // requests or duplicating financial/signing policy.
    const scan = () => {
      const nodes = body.current?.querySelectorAll<HTMLElement>('[role="alert"], [data-workflow-attention]');
      const messages = Array.from(nodes ?? []).map(node => node.textContent?.trim() ?? "").filter(Boolean);
      const unique = Array.from(new Set(messages));
      setAttention(previous => JSON.stringify(previous) === JSON.stringify(unique) ? previous : unique);
      const freshError = Array.from(nodes ?? []).find(node => node.getAttribute("role") === "alert" && !!node.textContent?.trim() && !seen.current.has(node.textContent.trim()));
      unique.forEach(message => seen.current.add(message));
      if (freshError) {
        revealTargetRef.current(freshError);
      }
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(body.current, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["role", "data-workflow-attention"] });
    return () => observer.disconnect();
  }, [open, group]);
  const id = `workflow-${devisId}-${group}`;
  return <section className="devis-workflow__group" data-group={group} aria-labelledby={`${id}-heading`}>
    <button id={`${id}-heading`} type="button" className="devis-workflow__heading" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => choose(group, !open)}>
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      <span className="devis-workflow__number">{String(workflowGroups.indexOf(group) + 1).padStart(2, "0")}</span>
      <strong>{labels[group]}</strong><small>{summary}</small>
    </button>
    {attention.length > 0 && <div className="devis-workflow__attention" aria-label={`${labels[group]} attention`}>
      {attention.map(message => <button key={message} type="button" onClick={() => {
        const target = Array.from(body.current?.querySelectorAll<HTMLElement>('[role="alert"], [data-workflow-attention]') ?? []).find(node => node.textContent?.trim() === message);
        revealTarget(target);
      }}>{message}</button>)}
    </div>}
    {visited.current && <div id={`${id}-body`} ref={body} hidden={!open} className="devis-workflow__body">{children}</div>}
  </section>;
}
