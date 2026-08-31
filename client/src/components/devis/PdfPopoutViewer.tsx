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
  Keyboard,
  Map,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  /**
   * A devis source enables the original / translated / combined selector.
   * A plain `pdfUrl` source is for other in-app documents, such as a Planning
   * Envelope import, that have one canonical PDF.
   */
  devisId?: number;
  devisCode: string;
  hasOriginal?: boolean;
  pdfUrl?: string;
  downloadUrl?: string;
  downloadName?: string;
  /** Stable ID used for the window's test IDs when no devis ID exists. */
  viewerId?: string;
  /** Gives non-quotation documents their own persisted window and visual identity. */
  viewerKind?: "source-pdf" | "floor-plan";
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

function constrainFrame(frame: StoredFrame): StoredFrame {
  if (typeof window === "undefined") return frame;
  const viewportW = Math.max(MIN_W, window.innerWidth);
  const viewportH = Math.max(MIN_H, window.innerHeight);
  const w = Math.min(viewportW, Math.max(MIN_W, frame.w));
  const h = Math.min(viewportH, Math.max(MIN_H, frame.h));
  const renderHeight = frame.minimized ? COLLAPSED_H : h;
  return {
    ...frame,
    x: Math.min(Math.max(0, viewportW - w), Math.max(0, frame.x)),
    y: Math.min(Math.max(0, viewportH - renderHeight), Math.max(0, frame.y)),
    w,
    h,
  };
}

function loadFrame(storageKey = STORAGE_KEY, viewerKind: "source-pdf" | "floor-plan" = "source-pdf"): StoredFrame {
  if (typeof window === "undefined") {
    return { x: 80, y: 80, w: 900, h: 700, minimized: false };
  }
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredFrame>;
      if (
        typeof parsed.x === "number" &&
        typeof parsed.y === "number" &&
        typeof parsed.w === "number" &&
        typeof parsed.h === "number"
      ) {
        return constrainFrame({
          x: parsed.x,
          y: parsed.y,
          w: Math.max(MIN_W, parsed.w),
          h: Math.max(MIN_H, parsed.h),
          minimized: !!parsed.minimized,
        });
      }
    }
  } catch {
    // ignore parse errors and fall through to default
  }
  const defaultW = viewerKind === "floor-plan"
    ? Math.min(640, Math.max(MIN_W, Math.floor(window.innerWidth * 0.42)))
    : Math.min(960, Math.max(MIN_W, window.innerWidth - 160));
  const defaultH = viewerKind === "floor-plan"
    ? Math.min(680, Math.max(MIN_H, window.innerHeight - 220))
    : Math.min(760, Math.max(MIN_H, window.innerHeight - 120));
  return {
    x: viewerKind === "floor-plan"
      ? 28
      : Math.max(20, Math.floor((window.innerWidth - defaultW) / 2)),
    y: viewerKind === "floor-plan" ? 72 : Math.max(20, Math.floor((window.innerHeight - defaultH) / 2)),
    w: defaultW,
    h: defaultH,
    minimized: false,
  };
}

function saveFrame(frame: StoredFrame, storageKey = STORAGE_KEY) {
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(frame));
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

function PdfPopoutViewerWindow({
  devisId,
  devisCode,
  hasOriginal = true,
  pdfUrl: suppliedPdfUrl,
  downloadUrl,
  downloadName,
  viewerId,
  viewerKind = "source-pdf",
  onClose,
}: PdfPopoutViewerProps) {
  const isDevisPdf = typeof devisId === "number";
  const idForTest = viewerId ?? String(devisId ?? "document");
  const frameStorageKey = viewerKind === "floor-plan"
    ? `architrak.floorPlanPopout.frame.${idForTest}`
    : STORAGE_KEY;
  const isFloorPlan = viewerKind === "floor-plan";
  const { data: translation } = useQuery<TranslationStatusResponse>({
    queryKey: isDevisPdf
      ? ["/api/devis", devisId, "translation"]
      : ["pdf-popout", idForTest],
    enabled: isDevisPdf,
  });
  const translationReady =
    translation?.status === "draft" ||
    translation?.status === "edited" ||
    translation?.status === "finalised";

  const availableVariants: PdfVariant[] = [];
  if (hasOriginal) availableVariants.push("original");
  if (isDevisPdf && translationReady) {
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

  const [frame, setFrame] = useState<StoredFrame>(() => loadFrame(frameStorageKey, viewerKind));
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
    saveFrame(frame, frameStorageKey);
  }, [frame, frameStorageKey]);

  useEffect(() => {
    const keepFrameUsable = () => setFrame((current) => constrainFrame(current));
    window.addEventListener("resize", keepFrameUsable);
    return () => window.removeEventListener("resize", keepFrameUsable);
  }, []);

  // Probe the PDF endpoint with HEAD before letting the iframe show; native
  // <iframe> never fires `onerror` for HTTP failures, so we can't surface a
  // retry-able error state without an explicit probe. Cheap (HEAD only).
  const pdfUrl = isDevisPdf
    ? `/api/devis/${devisId}/pdf?variant=${variant}`
    : suppliedPdfUrl ?? "";
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
      setFrame(constrainFrame({
        ...d.startFrame,
        w: Math.max(MIN_W, d.startFrame.w + dx),
        h: Math.max(MIN_H, d.startFrame.h + dy),
      }));
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

  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const root = containerRef.current;
        const active = document.activeElement as HTMLElement | null;
        if (root && active && root.contains(active)) {
          e.stopPropagation();
          onClose();
        }
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
  }, [onClose, nudgePosition]);

  const resolvedDownloadName = downloadName ?? `DEVIS-${devisCode}-${variant}.pdf`;
  const resolvedDownloadUrl = downloadUrl ?? pdfUrl;
  const isMinimized = !!frame.minimized;
  const renderHeight = isMinimized ? COLLAPSED_H : frame.h;

  const node = (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="false"
      aria-label={`${isFloorPlan ? "Floor plan" : "PDF"} viewer for ${devisCode}`}
      tabIndex={-1}
      data-testid={`dialog-pdf-popout-${idForTest}`}
      data-minimized={isMinimized ? "true" : "false"}
      className={`fixed z-[60] flex flex-col bg-white dark:bg-neutral-900 border rounded-lg shadow-2xl overflow-hidden focus:outline-none ${isFloorPlan ? "border-[#32656a]/40 dark:border-[#5d9698]/40" : "border-[#0B2545]/30 dark:border-neutral-700"}`}
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
        className={`flex items-center gap-2 px-3 py-2 text-white cursor-move select-none ${isFloorPlan ? "bg-[#24565c]" : "bg-[#0B2545]"}`}
        onPointerDown={onPointerDownDrag}
        data-testid={`pdf-popout-handle-${idForTest}`}
      >
        <GripHorizontal size={14} className="opacity-70" />
        {isFloorPlan ? <Map size={14} /> : <FileText size={14} />}
        <span
          className="text-[12px] font-semibold tracking-tight truncate"
          data-testid={`pdf-popout-title-${idForTest}`}
        >
          {isFloorPlan ? `Floor plan · ${devisCode}` : devisCode}
        </span>
        <div
          className="ml-auto flex items-center gap-2"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {availableVariants.length > 1 && !isMinimized ? (
            <Select value={variant} onValueChange={onVariantChange}>
              <SelectTrigger
                className="h-7 w-[140px] bg-white/10 border-white/20 text-white text-[11px] focus:ring-white/40"
                data-testid={`select-pdf-variant-${idForTest}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableVariants.map((v) => (
                  <SelectItem
                    key={v}
                    value={v}
                    data-testid={`select-pdf-variant-${idForTest}-option-${v}`}
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
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-white hover:bg-white/15"
                data-testid={`button-pdf-popout-shortcuts-${idForTest}`}
                aria-label="Show keyboard shortcuts"
              >
                <Keyboard size={14} />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-72 text-[12px]"
              data-testid={`popover-pdf-popout-shortcuts-${idForTest}`}
            >
              <div className="font-semibold mb-2">Keyboard shortcuts</div>
              <ul className="space-y-1.5">
                <li className="flex items-start justify-between gap-3">
                  <span className="text-muted-foreground">Resize (focus the resize handle)</span>
                  <kbd className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded border">
                    ← ↑ → ↓
                  </kbd>
                </li>
                <li className="flex items-start justify-between gap-3">
                  <span className="text-muted-foreground">Resize larger step</span>
                  <kbd className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded border">
                    Shift + Arrow
                  </kbd>
                </li>
                <li className="flex items-start justify-between gap-3">
                  <span className="text-muted-foreground">Move the popout</span>
                  <kbd className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded border">
                    Alt + Arrow
                  </kbd>
                </li>
                <li className="flex items-start justify-between gap-3">
                  <span className="text-muted-foreground">Move larger step</span>
                  <kbd className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded border">
                    Alt + Shift + Arrow
                  </kbd>
                </li>
                <li className="flex items-start justify-between gap-3">
                  <span className="text-muted-foreground">Close</span>
                  <kbd className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded border">
                    Esc
                  </kbd>
                </li>
              </ul>
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-white hover:bg-white/15"
            asChild
          >
            <a
              href={resolvedDownloadUrl}
              download={resolvedDownloadName}
              data-testid={`button-pdf-download-${idForTest}`}
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
            data-testid={`button-pdf-popout-minimize-${idForTest}`}
            aria-label={isMinimized ? `Restore ${isFloorPlan ? "floor plan" : "PDF"} viewer` : `Minimize ${isFloorPlan ? "floor plan" : "PDF"} viewer`}
          >
            {isMinimized ? <Maximize2 size={14} /> : <Minus size={14} />}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-white hover:bg-white/15"
            onClick={onClose}
            data-testid={`button-pdf-popout-close-${idForTest}`}
            aria-label={`Close ${isFloorPlan ? "floor plan" : "PDF"} viewer`}
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
              data-testid={`pdf-popout-empty-${idForTest}`}
            >
              No PDF available
            </div>
          ) : loadState.kind === "error" ? (
            <div
              className="h-full flex flex-col items-center justify-center gap-3 text-center px-6"
              data-testid={`pdf-popout-error-${idForTest}`}
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
                data-testid={`button-pdf-popout-retry-${idForTest}`}
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
              title={`${isFloorPlan ? "Floor plan" : "PDF"} — ${devisCode}${isFloorPlan ? "" : ` (${variant})`}`}
              className="w-full h-full border-0"
              data-testid={`pdf-popout-iframe-${idForTest}`}
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
        // This is deliberately a non-modal floating window: architects can
        // drag it beside a form and continue editing with the PDF in view.
        // The resize handle is a real button so it's reachable via Tab and
        // operable via arrow keys (Shift = larger step) for keyboard users.
        <button
          type="button"
          className={`absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize focus:outline-none focus-visible:ring-2 ${isFloorPlan ? "bg-[#24565c]/20 hover:bg-[#24565c]/40 focus:bg-[#24565c]/60 focus-visible:ring-[#24565c]" : "bg-[#0B2545]/20 hover:bg-[#0B2545]/40 focus:bg-[#0B2545]/60 focus-visible:ring-[#0B2545]"}`}
          onPointerDown={onPointerDownResize}
          onKeyDown={onResizeKeyDown}
          data-testid={`pdf-popout-resize-${idForTest}`}
          data-pdf-popout-resize="true"
          aria-label={`Resize ${isFloorPlan ? "floor plan" : "PDF"} viewer (use arrow keys, Shift for larger step)`}
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

export function PdfPopoutViewer(props: PdfPopoutViewerProps) {
  const viewerIdentity = [
    props.viewerKind ?? "source-pdf",
    props.viewerId ?? props.devisId ?? "document",
    props.pdfUrl ?? props.devisId ?? "",
  ].join(":");

  return <PdfPopoutViewerWindow key={viewerIdentity} {...props} />;
}
