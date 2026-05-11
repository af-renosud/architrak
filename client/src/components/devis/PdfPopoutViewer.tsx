import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Download, FileText, GripHorizontal } from "lucide-react";
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
}

const STORAGE_KEY = "architrak.pdfPopout.frame";
const MIN_W = 480;
const MIN_H = 360;

function loadFrame(): StoredFrame {
  if (typeof window === "undefined") {
    return { x: 80, y: 80, w: 900, h: 700 };
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
  // Reconcile if translation readiness arrives after mount and the chosen
  // variant is no longer available.
  useEffect(() => {
    if (!availableVariants.includes(variant) && availableVariants.length > 0) {
      setVariant(
        translationReady && hasOriginal
          ? "combined"
          : availableVariants[0],
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translationReady, hasOriginal]);

  const [frame, setFrame] = useState<StoredFrame>(() => loadFrame());
  const dragRef = useRef<{
    mode: "move" | "resize";
    startX: number;
    startY: number;
    startFrame: StoredFrame;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveFrame(frame);
  }, [frame]);

  const onPointerDownDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      mode: "move",
      startX: e.clientX,
      startY: e.clientY,
      startFrame: { ...frame },
    };
  };

  const onPointerDownResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
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

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Capture the element that had focus when we opened, so we can return
    // focus to it on close (accessibility: focus restoration).
    openerRef.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      // Arrow / PageUp / PageDown are forwarded to the iframe by the browser
      // when it has focus. We auto-focus the iframe on load so the
      // architect's first arrow press already paginates without a click.
    };
    window.addEventListener("keydown", onKey);
    // Auto-focus the container so Esc works immediately. The iframe is
    // focused once it loads (see iframe.onLoad below) so arrow keys flow
    // straight to the embedded PDF viewer.
    const t = window.setTimeout(() => containerRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      // Return focus to the opener (e.g. the "View PDF" button) so screen
      // readers and keyboard users land back where they were.
      const opener = openerRef.current;
      if (opener && typeof opener.focus === "function") {
        try {
          opener.focus();
        } catch {
          // ignore — opener may have unmounted
        }
      }
    };
  }, [onClose]);

  const pdfUrl = `/api/devis/${devisId}/pdf?variant=${variant}`;
  const downloadName = `DEVIS-${devisCode}-${variant}.pdf`;

  const node = (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={`PDF viewer for ${devisCode}`}
      tabIndex={-1}
      data-testid={`dialog-pdf-popout-${devisId}`}
      className="fixed z-[60] flex flex-col bg-white dark:bg-neutral-900 border border-[#0B2545]/30 dark:border-neutral-700 rounded-lg shadow-2xl overflow-hidden focus:outline-none"
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.w,
        height: frame.h,
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
        <div className="ml-auto flex items-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
          {availableVariants.length > 1 ? (
            <Select value={variant} onValueChange={(v) => setVariant(v as PdfVariant)}>
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
            onClick={onClose}
            data-testid={`button-pdf-popout-close-${devisId}`}
            aria-label="Close PDF viewer"
          >
            <X size={14} />
          </Button>
        </div>
      </div>
      <div className="flex-1 bg-neutral-100 dark:bg-neutral-800">
        {availableVariants.length === 0 ? (
          <div
            className="h-full flex items-center justify-center text-[12px] text-muted-foreground"
            data-testid={`pdf-popout-empty-${devisId}`}
          >
            No PDF available
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            key={pdfUrl}
            src={pdfUrl}
            title={`PDF — ${devisCode} (${variant})`}
            className="w-full h-full border-0"
            data-testid={`pdf-popout-iframe-${devisId}`}
            onLoad={() => {
              // Hand focus to the embedded PDF viewer so the browser's
              // native page nav (arrow keys / PageUp / PageDown) is live
              // immediately after open, not after a manual click.
              try {
                iframeRef.current?.focus();
              } catch {
                // ignore — focus may fail on cross-origin frames
              }
            }}
          />
        )}
      </div>
      <div
        className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize bg-[#0B2545]/20 hover:bg-[#0B2545]/40"
        onPointerDown={onPointerDownResize}
        data-testid={`pdf-popout-resize-${devisId}`}
        aria-label="Resize PDF viewer"
        style={{
          clipPath: "polygon(100% 0, 100% 100%, 0 100%)",
        }}
      />
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}
