import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Download,
  FileText,
  GripHorizontal,
  Minus,
  Maximize2,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";

export type PdfVariant = "original" | "translation" | "combined";

interface PdfPopoutViewerProps {
  devisId: number;
  devisCode: string;
  hasOriginal: boolean;
  onClose: () => void;
}

interface StoredFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  minimized?: boolean;
}

const STORAGE_KEY = "architrak.pdfPopout.frame";
const MIN_W = 480;
const MIN_H = 360;
const COLLAPSED_H = 40;
// Keyboard nudge step sizes for resize (arrow keys on the resize handle) and
// move (Alt+Arrow anywhere inside the dialog). Shift multiplies for fast nudge.
const NUDGE_STEP = 16;
const NUDGE_STEP_LARGE = 64;

function loadFrame(): StoredFrame {
  if (typeof window === "undefined") {
    return { x: 80, y: 80, w: 900, h: 700, minimized: false };
  }
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredFrame>;
      if (
        typeof parsed.x === "number" &&
        typeof parsed.y === "number" &&
        typeof parsed.w === "number" &&
        typeof parsed.h === "number"
      ) {
        return {
          x: Math.max(0, parsed.x),
          y: Math.max(0, parsed.y),
          w: Math.max(MIN_W, parsed.w),
          h: Math.max(MIN_H, parsed.h),
          minimized: !!parsed.minimized,
        };
      }
    }
  } catch {
    // ignore parse errors and fall through to default
  }
  const defaultW = Math.min(960, Math.max(MIN_W, window.innerWidth - 160));
  const defaultH = Math.min(760, Math.max(MIN_H, window.innerHeight - 120));
  return {
    x: Math.max(20, Math.floor((window.innerWidth - defaultW) / 2)),
    y: Math.max(20, Math.floor((window.innerHeight - defaultH) / 2)),
    w: defaultW,
    h: defaultH,
    minimized: false,
  };
}

function saveFrame(frame: StoredFrame) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(frame));
  } catch {
    // sessionStorage may be unavailable (private mode etc.) — non-fatal
  }
}

interface TranslationStatusResponse {
  status: "missing" | "draft" | "edited" | "finalised" | string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), [role="combobox"], iframe, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function PdfPopoutViewer({
  devisId,
  devisCode,
  hasOriginal,
  onClose,
}: PdfPopoutViewerProps) {
  const { data: translation } = useQuery<TranslationStatusResponse>({
    queryKey: ["/api/devis", devisId, "translation"],
  });
  const translationReady =
    translation?.status === "draft" ||
    translation?.status === "edited" ||
    translation?.status === "finalised";

  const availableVariants: PdfVariant[] = [];
  if (hasOriginal) availableVariants.push("original");
  if (translationReady) {
    availableVariants.push("translation");
    if (hasOriginal) availableVariants.push("combined");
  }

  const defaultVariant: PdfVariant =
    translationReady && hasOriginal
      ? "combined"
      : availableVariants[0] ?? "original";

  const [variant, setVariant] = useState<PdfVariant>(defaultVariant);
  // True once the user explicitly picked a variant from the selector — we
  // then stop reconciling against the auto-default so a late-arriving
  // translation row doesn't yank the viewer away from the user's choice.
  const userPickedRef = useRef(false);

  useEffect(() => {
    if (userPickedRef.current) return;
    if (availableVariants.length === 0) return;
    const want: PdfVariant =
      translationReady && hasOriginal ? "combined" : availableVariants[0];
    if (want !== variant) setVariant(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translationReady, hasOriginal]);

  const onVariantChange = (v: string) => {
    userPickedRef.current = true;
    setVariant(v as PdfVariant);
  };

  const [frame, setFrame] = useState<StoredFrame>(() => loadFrame());
  const [reloadToken, setReloadToken] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const dragRef = useRef<{
    mode: "move" | "resize";
    startX: number;
    startY: number;
    startFrame: StoredFrame;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    saveFrame(frame);
  }, [frame]);

  // Probe the PDF endpoint with HEAD before letting the iframe show; native
  // <iframe> never fires `onerror` for HTTP failures, so we can't surface a
  // retry-able error state without an explicit probe. Cheap (HEAD only).
  const pdfUrl = `/api/devis/${devisId}/pdf?variant=${variant}`;
  useEffect(() => {
    let cancelled = false;
    setLoadState({ kind: "loading" });
    if (availableVariants.length === 0) return;
    fetch(pdfUrl, { method: "HEAD", credentials: "same-origin" })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setLoadState({
            kind: "error",
            message: `The PDF could not be loaded (${res.status}).`,
          });
        } else {
          setLoadState({ kind: "ok" });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setLoadState({
          kind: "error",
          message: "The PDF could not be loaded. Check your connection and try again.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [pdfUrl, reloadToken, availableVariants.length]);

  const onPointerDownDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: "move",
      startX: e.clientX,
      startY: e.clientY,
      startFrame: { ...frame },
    };
  };

  const onPointerDownResize = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || frame.minimized) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: "resize",
      startX: e.clientX,
      startY: e.clientY,
      startFrame: { ...frame },
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.mode === "move") {
      const maxX = Math.max(0, window.innerWidth - 80);
      const maxY = Math.max(0, window.innerHeight - 40);
      setFrame({
        ...d.startFrame,
        x: Math.min(maxX, Math.max(-d.startFrame.w + 80, d.startFrame.x + dx)),
        y: Math.min(maxY, Math.max(0, d.startFrame.y + dy)),
      });
    } else {
      setFrame({
        ...d.startFrame,
        w: Math.max(MIN_W, d.startFrame.w + dx),
        h: Math.max(MIN_H, d.startFrame.h + dy),
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore — capture may have been released already
      }
      dragRef.current = null;
    }
  };

  // Keyboard nudge for moving the popout. Alt+Arrow nudges, Alt+Shift+Arrow
   // nudges by a larger step. Active only when focus is inside the dialog so
   // it never collides with arrow-key navigation in surrounding UI.
  const nudgePosition = useCallback(
    (dx: number, dy: number) => {
      setFrame((f) => {
        if (f.minimized) return f;
        const maxX = Math.max(0, window.innerWidth - 80);
        const maxY = Math.max(0, window.innerHeight - 40);
        return {
          ...f,
          x: Math.min(maxX, Math.max(-f.w + 80, f.x + dx)),
          y: Math.min(maxY, Math.max(0, f.y + dy)),
        };
      });
    },
    [],
  );

  // Keyboard resize via arrow keys when the resize handle is focused.
  const onResizeKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (frame.minimized) return;
    const step = e.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP;
    let dw = 0;
    let dh = 0;
    switch (e.key) {
      case "ArrowRight":
        dw = step;
        break;
      case "ArrowLeft":
        dw = -step;
        break;
      case "ArrowDown":
        dh = step;
        break;
      case "ArrowUp":
        dh = -step;
        break;
      default:
        return;
    }
    e.preventDefault();
    setFrame((f) => ({
      ...f,
      w: Math.max(MIN_W, Math.min(window.innerWidth - f.x, f.w + dw)),
      h: Math.max(MIN_H, Math.min(window.innerHeight - f.y, f.h + dh)),
    }));
  };

  const trapFocus = useCallback((e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const root = containerRef.current;
    if (!root) return;
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !root.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      // Alt+Arrow nudges the popout's position when focus is inside the
      // dialog. Shift makes the step larger. Skipped if the resize handle
      // owns focus, since arrows there resize instead.
      if (
        e.altKey &&
        (e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight")
      ) {
        const root = containerRef.current;
        const active = document.activeElement as HTMLElement | null;
        if (root && active && root.contains(active)) {
          const isResizeHandle =
            active.getAttribute("data-pdf-popout-resize") === "true";
          if (!isResizeHandle) {
            e.preventDefault();
            const step = e.shiftKey ? NUDGE_STEP_LARGE : NUDGE_STEP;
            const dx =
              e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
            const dy =
              e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
            nudgePosition(dx, dy);
            return;
          }
        }
      }
      trapFocus(e);
    };
    window.addEventListener("keydown", onKey, true);
    const t = window.setTimeout(() => containerRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(t);
      const opener = openerRef.current;
      if (opener && typeof opener.focus === "function") {
        try {
          opener.focus();
        } catch {
          // opener may have unmounted
        }
      }
    };
  }, [onClose, trapFocus, nudgePosition]);

  const downloadName = `DEVIS-${devisCode}-${variant}.pdf`;
  const isMinimized = !!frame.minimized;
  const renderHeight = isMinimized ? COLLAPSED_H : frame.h;

  const node = (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={`PDF viewer for ${devisCode}`}
      tabIndex={-1}
      data-testid={`dialog-pdf-popout-${devisId}`}
      data-minimized={isMinimized ? "true" : "false"}
      className="fixed z-[60] flex flex-col bg-white dark:bg-neutral-900 border border-[#0B2545]/30 dark:border-neutral-700 rounded-lg shadow-2xl overflow-hidden focus:outline-none"
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.w,
        height: renderHeight,
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 bg-[#0B2545] text-white cursor-move select-none"
        onPointerDown={onPointerDownDrag}
        data-testid={`pdf-popout-handle-${devisId}`}
      >
        <GripHorizontal size={14} className="opacity-70" />
        <FileText size={14} />
        <span
          className="text-[12px] font-semibold tracking-tight truncate"
          data-testid={`pdf-popout-title-${devisId}`}
        >
          {devisCode}
        </span>
        <div
          className="ml-auto flex items-center gap-2"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {availableVariants.length > 1 && !isMinimized ? (
            <Select value={variant} onValueChange={onVariantChange}>
              <SelectTrigger
                className="h-7 w-[140px] bg-white/10 border-white/20 text-white text-[11px] focus:ring-white/40"
                data-testid={`select-pdf-variant-${devisId}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableVariants.map((v) => (
                  <SelectItem
                    key={v}
                    value={v}
                    data-testid={`select-pdf-variant-${devisId}-option-${v}`}
                  >
                    {v === "original"
                      ? "Original (FR)"
                      : v === "translation"
                        ? "Translation (EN)"
                        : "Combined (EN+FR)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-white hover:bg-white/15"
            asChild
          >
            <a
              href={pdfUrl}
              download={downloadName}
              data-testid={`button-pdf-download-${devisId}`}
              aria-label="Download PDF"
              onClick={(e) => e.stopPropagation()}
            >
              <Download size={14} />
            </a>
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-white hover:bg-white/15"
            onClick={() =>
              setFrame((f) => ({ ...f, minimized: !f.minimized }))
            }
            data-testid={`button-pdf-popout-minimize-${devisId}`}
            aria-label={isMinimized ? "Restore PDF viewer" : "Minimize PDF viewer"}
          >
            {isMinimized ? <Maximize2 size={14} /> : <Minus size={14} />}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-white hover:bg-white/15"
            onClick={onClose}
            data-testid={`button-pdf-popout-close-${devisId}`}
            aria-label="Close PDF viewer"
          >
            <X size={14} />
          </Button>
        </div>
      </div>
      {!isMinimized && (
        <div className="flex-1 bg-neutral-100 dark:bg-neutral-800 relative">
          {availableVariants.length === 0 ? (
            <div
              className="h-full flex items-center justify-center text-[12px] text-muted-foreground"
              data-testid={`pdf-popout-empty-${devisId}`}
            >
              No PDF available
            </div>
          ) : loadState.kind === "error" ? (
            <div
              className="h-full flex flex-col items-center justify-center gap-3 text-center px-6"
              data-testid={`pdf-popout-error-${devisId}`}
            >
              <AlertTriangle size={28} className="text-amber-500" />
              <p className="text-[12px] text-foreground max-w-xs">
                {loadState.message}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5 text-[11px]"
                onClick={() => setReloadToken((n) => n + 1)}
                data-testid={`button-pdf-popout-retry-${devisId}`}
              >
                <RefreshCw size={12} />
                Retry
              </Button>
            </div>
          ) : (
            <iframe
              ref={iframeRef}
              key={`${pdfUrl}#${reloadToken}`}
              src={pdfUrl}
              title={`PDF — ${devisCode} (${variant})`}
              className="w-full h-full border-0"
              data-testid={`pdf-popout-iframe-${devisId}`}
              onLoad={() => {
                try {
                  iframeRef.current?.focus();
                } catch {
                  // ignore — focus may fail on cross-origin frames
                }
              }}
            />
          )}
        </div>
      )}
      {!isMinimized && (
        // Modal dialog decision: this popout is treated as a true modal
        // (aria-modal + focus trap + Esc closes + opener-focus restore).
        // The resize handle is a real button so it's reachable via Tab and
        // operable via arrow keys (Shift = larger step) for keyboard users.
        <button
          type="button"
          className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize bg-[#0B2545]/20 hover:bg-[#0B2545]/40 focus:bg-[#0B2545]/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0B2545]"
          onPointerDown={onPointerDownResize}
          onKeyDown={onResizeKeyDown}
          data-testid={`pdf-popout-resize-${devisId}`}
          data-pdf-popout-resize="true"
          aria-label="Resize PDF viewer (use arrow keys, Shift for larger step)"
          style={{
            clipPath: "polygon(100% 0, 100% 100%, 0 100%)",
          }}
        />
      )}
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}
