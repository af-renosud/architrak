import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Check, GripVertical, Minus, NotebookPen, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JOBS_MAX_LENGTH, useJobsJotter } from "./use-jobs-jotter";
import "./JobsJotter.css";

export default function JobsJotter() {
  const pad = useJobsJotter();
  const [open, setOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [position, setPosition] = useState({ x: 12, y: 12 });
  const panel = useRef<HTMLElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const initialPosition = useRef(false);

  function bounded(x: number, y: number) {
    const rect = panel.current?.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    return {
      x: Math.max(left + 12, Math.min(x, left + width - (rect?.width || 420) - 12)),
      y: Math.max(top + 12, Math.min(y, top + height - (rect?.height || 540) - 12)),
    };
  }

  useEffect(() => {
    if (!open) return;
    if (!initialPosition.current) {
      initialPosition.current = true;
      setPosition(bounded(window.innerWidth - 500, window.innerHeight - 630));
    } else {
      setPosition(value => bounded(value.x, value.y));
    }
    const resize = () => setPosition(value => bounded(value.x, value.y));
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
    };
  }, [open]);

  useEffect(() => { setReviewed(false); }, [pad.conflict]);
  useEffect(() => {
    if (open && pad.saved) editor.current?.focus({ preventScroll: true });
  }, [open, !!pad.saved]);

  function hide() {
    void pad.flush();
    setOpen(false);
    setConfirmClear(false);
    launcher.current?.focus();
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!drag.current) return;
    const start = drag.current;
    setPosition(bounded(start.left + event.clientX - start.x, start.top + event.clientY - start.y));
  }

  function moveByKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 10;
    setPosition(value => bounded(value.x + direction[0] * step, value.y + direction[1] * step));
  }

  const unsaved = pad.dirty || !!pad.conflict || !!pad.error;
  const status = pad.loading ? "Loading notes" : pad.saving ? "Saving…" : unsaved ? "Unsaved" : "Saved";

  return (
    <>
      <button ref={launcher} type="button" className="jobs-launcher" aria-expanded={open}
        aria-controls="jobs-jotter" onClick={() => open ? hide() : setOpen(true)}>
        <NotebookPen size={16} aria-hidden="true" />
        Jobs
        {(unsaved || pad.saving) && <span className="jobs-launcher-dot" aria-label={status} />}
      </button>
      <section ref={panel} id="jobs-jotter" role="region" aria-labelledby="jobs-title"
        className="jobs-jotter" hidden={!open} style={{ left: position.x, top: position.y }}
        onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); hide(); } }}>
        <header className="jobs-header">
          <button type="button" className="jobs-icon jobs-drag" aria-label="Move Jobs. Use arrow keys; hold Shift for larger steps."
            title="Drag to move, or use arrow keys" onPointerDown={startDrag} onPointerMove={moveDrag}
            onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
            onLostPointerCapture={() => { drag.current = null; }} onKeyDown={moveByKeyboard}>
            <GripVertical size={17} aria-hidden="true" />
          </button>
          <div className="jobs-heading"><h2 id="jobs-title">Jobs</h2><p>Personal jotter · across all projects</p></div>
          <button type="button" className="jobs-icon" aria-label="Minimise Jobs" title="Minimise Jobs" onClick={hide}><Minus size={17} aria-hidden="true" /></button>
          <button type="button" className="jobs-icon" aria-label="Close Jobs — keep notes" title="Close — notes are kept" onClick={hide}><X size={17} aria-hidden="true" /></button>
        </header>
        <div className="jobs-body">
          {pad.loading ? (
            <div className="jobs-skeleton" role="status" aria-label="Loading your saved notes"><span /><span /><span /></div>
          ) : (
            <>
              {pad.error && (
                <div className="jobs-message" data-error="" role="alert">
                  <p>{pad.error}</p>
                  <Button type="button" size="sm" variant="outline" onClick={pad.retry}>Retry {pad.saved ? "save" : "loading"}</Button>
                </div>
              )}
              {pad.conflict && (
                <div className="jobs-message" role="alert">
                  <p><strong>Another tab saved a different version.</strong> Your draft below has not been replaced. Copy anything you need from the saved version into your draft, then review and save.</p>
                  <label htmlFor="jobs-remote">Saved version from the other tab</label>
                  <textarea id="jobs-remote" className="jobs-remote" readOnly value={pad.conflict.content}
                    placeholder="The other tab saved an empty note." />
                  <label className="jobs-review"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} />
                    <span>I have reviewed both versions. Save my draft below as the combined version.</span></label>
                  <div className="jobs-actions"><Button type="button" size="sm" disabled={!reviewed} onClick={pad.saveReviewed}>Save reviewed version</Button></div>
                </div>
              )}
              <label htmlFor="jobs-content" className="sr-only">Your personal Jobs notes{pad.conflict ? " — your unsaved draft" : ""}</label>
              <textarea ref={editor} id="jobs-content" className="jobs-editor" value={pad.content}
                disabled={!pad.saved} maxLength={JOBS_MAX_LENGTH} spellCheck
                placeholder={"A thought, a question, a detail to check…\n\nYour notes stay here when you change projects or close this pad."}
                onChange={event => pad.edit(event.target.value)} />
              {confirmClear && (
                <div className="jobs-message" role="group" aria-label="Confirm deletion of all Jobs notes">
                  <p><strong>Delete all notes?</strong> This permanently saves an empty pad. Closing Jobs never deletes notes.</p>
                  <div className="jobs-actions">
                    <Button type="button" size="sm" variant="destructive" onClick={() => { pad.edit(""); setConfirmClear(false); void pad.flush(); }}>Delete all notes</Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setConfirmClear(false)}>Keep notes</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <footer className="jobs-footer">
          <span className="jobs-status" role="status" aria-live="polite">
            {status === "Saved" ? <Check size={12} aria-hidden="true" /> : <span className="jobs-dot" data-pending="true" />}
            {status}
          </span>
          <span title="Characters used">{pad.content.length.toLocaleString("en-GB")} / 100,000</span>
          <button type="button" className="jobs-icon" aria-label="Delete all notes" title="Delete all notes"
            disabled={!pad.saved || !pad.content || !!pad.conflict || pad.loading || pad.saving}
            onClick={() => setConfirmClear(true)}><Trash2 size={14} aria-hidden="true" /></button>
        </footer>
      </section>
    </>
  );
}
