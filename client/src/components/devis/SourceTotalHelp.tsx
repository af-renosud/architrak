import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** A single help surface for mouse, keyboard and touch; never hides the next action. */
export function SourceTotalHelp({ kind = "confirmation" }: { kind?: "confirmation" | "difference" | "missing" }) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const dismissed = useRef(false);
  const cancelClose = () => clearTimeout(closeTimer.current);
  const show = () => { cancelClose(); dismissed.current = false; setOpen(true); };
  const scheduleClose = () => {
    cancelClose();
    // Bridge the gap between the trigger and portalled panel.
    closeTimer.current = setTimeout(() => {
      if (!pinned.current && document.activeElement !== trigger.current && !content.current?.contains(document.activeElement)) setOpen(false);
    }, 180);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const title = kind === "difference" ? "The working figures differ" : kind === "missing" ? "Financial information is missing" : "Confirm the original, not a new total";
  return <Popover open={open} onOpenChange={next => {
    cancelClose(); setOpen(next);
    if (!next) { pinned.current = false; dismissed.current = true; }
  }}>
    <span onMouseEnter={show} onMouseLeave={scheduleClose}>
      <PopoverTrigger asChild>
        <button ref={trigger} type="button" className="text-[11px] underline underline-offset-4"
          onFocus={() => { if (!dismissed.current) { cancelClose(); setOpen(true); } }}
          onBlur={() => { dismissed.current = false; scheduleClose(); }}
          onClick={event => { event.preventDefault(); pinned.current = true; show(); }}>
          Why am I seeing this?
        </button>
      </PopoverTrigger>
    </span>
    <PopoverContent ref={content} aria-label={title} className="text-xs leading-relaxed"
      onMouseEnter={cancelClose} onMouseLeave={scheduleClose} onFocusCapture={cancelClose} onBlurCapture={scheduleClose}
      onOpenAutoFocus={event => event.preventDefault()}>
      <p className="font-semibold mb-2">{title}</p>
      {kind === "difference" ? <>
        <p>A calculated working total differs from the confirmed original PDF total, or the saved header differs from the item calculation. This is an actual discrepancy, not simply an unrecorded check.</p>
        <p className="mt-2">Follow the flagged check. Compare amounts, VAT, discounts and included options with the original PDF, then save any corrections. Do not change the original total just to balance the working figures; confirming it does not adjust them.</p>
      </> : kind === "missing" ? <>
        <p>Missing or invalid VAT, amounts or discount information prevents a reliable working total. It does not by itself prove that the original PDF total is wrong.</p>
        <p className="mt-2">Open the flagged field, copy the actual value from the original PDF and save any corrections. No VAT rate is assumed. Confirming the original total does not fill missing fields or automatically balance the working figures.</p>
      </> : <>
        <p>This records the total including VAT (TTC) printed on the contractor’s original PDF. An unrecorded check is not evidence of a wrong amount.</p>
        <p className="mt-2">Compare the suggested amount with the PDF, or enter the printed total yourself. Keep its page number and confirm only after checking.</p>
        <p className="mt-2">Confirmation does not change the original PDF or automatically balance your working figures. Missing VAT and any actual difference still need separate review. Save only if you change the working quotation.</p>
      </>}
    </PopoverContent>
  </Popover>;
}
