import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Button } from "@/components/ui/button";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Link as LinkIcon,
  Image as ImageIcon,
  Loader2,
  Check,
  AlertTriangle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import {
  contextDocSchema,
  isSafeContextHref,
  isContextDocEmpty,
  CONTEXT_ASSET_MAX_BYTES,
  type ContextDoc,
} from "@shared/context-doc";
import type { DevisLineContext } from "@shared/schema";

/**
 * Rich-text "context" editor for one devis line item. Content is persisted
 * as a strict JSON document (shared/context-doc.ts) and rendered into the
 * translated PDF. Supports formatted text, bullet/numbered lists, pasted or
 * uploaded images (PNG/JPEG/WebP), and https/mailto hyperlinks.
 *
 * Saves are debounced + flushed on blur, carry the revision they were based
 * on, and surface a conflict warning when someone else edited concurrently.
 */

interface DevisLineContextEditorProps {
  devisId: number;
  lineItemId: number;
  lineNumber: number;
  context: DevisLineContext | null;
  /** Finalised translations are approval artifacts — show contexts read-only. */
  readOnly?: boolean;
}

/** Custom atom image node — references an owned uploaded asset by id only. */
function buildContextImageNode(devisId: number) {
  return Node.create({
    name: "image",
    group: "block",
    atom: true,
    draggable: true,
    addAttributes() {
      return {
        assetId: { default: null },
        alt: { default: null },
      };
    },
    parseHTML() {
      return [
        {
          tag: "img[data-asset-id]",
          getAttrs: (el) => {
            const id = Number((el as HTMLElement).getAttribute("data-asset-id"));
            return Number.isInteger(id) && id > 0 ? { assetId: id } : false;
          },
        },
      ];
    },
    renderHTML({ node }) {
      return [
        "img",
        mergeAttributes({
          "data-asset-id": String(node.attrs.assetId),
          src: `/api/devis/${devisId}/context-assets/${node.attrs.assetId}`,
          alt: node.attrs.alt ?? "",
          class: "ctx-editor-img",
        }),
      ];
    },
  });
}

type EditorJsonNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: EditorJsonNode[];
};

/**
 * Normalizes TipTap's editor JSON into the strict shared document shape:
 * drops unknown node/mark types and extraneous attributes (e.g. the link
 * extension's target/rel/class) so the server-side strict schema accepts
 * exactly what we send. Unknown block nodes degrade to their text content
 * being dropped — the editor never produces them with our extension set.
 */
export function normalizeEditorJson(json: EditorJsonNode): ContextDoc {
  const normInline = (n: EditorJsonNode): EditorJsonNode | null => {
    if (n.type === "hardBreak") return { type: "hardBreak" };
    if (n.type === "text") {
      if (!n.text) return null;
      const marks = (n.marks ?? [])
        .map((m) => {
          if (m.type === "bold" || m.type === "italic") return { type: m.type };
          if (m.type === "link") {
            const href = typeof m.attrs?.href === "string" ? m.attrs.href : "";
            return isSafeContextHref(href) ? { type: "link", attrs: { href } } : null;
          }
          return null;
        })
        .filter((m): m is NonNullable<typeof m> => m !== null);
      return { type: "text", text: n.text, ...(marks.length ? { marks } : {}) };
    }
    return null;
  };

  const normBlock = (n: EditorJsonNode): EditorJsonNode | null => {
    switch (n.type) {
      case "paragraph": {
        const content = (n.content ?? []).map(normInline).filter((c): c is EditorJsonNode => c !== null);
        return { type: "paragraph", ...(content.length ? { content } : {}) };
      }
      case "bulletList":
      case "orderedList": {
        const items: EditorJsonNode[] = [];
        for (const item of n.content ?? []) {
          const content = (item.content ?? [])
            .map(normBlock)
            .filter((c): c is EditorJsonNode => c !== null && c.type !== "image");
          if (content.length) items.push({ type: "listItem", content });
        }
        return items.length ? { type: n.type, content: items } : null;
      }
      case "image": {
        const assetId = Number(n.attrs?.assetId);
        if (!Number.isInteger(assetId) || assetId <= 0) return null;
        const alt = typeof n.attrs?.alt === "string" && n.attrs.alt ? { alt: n.attrs.alt } : {};
        return { type: "image", attrs: { assetId, ...alt } };
      }
      default:
        return null;
    }
  };

  const content = (json.content ?? []).map(normBlock).filter((c): c is EditorJsonNode => c !== null);
  return { type: "doc", content } as ContextDoc;
}

export function DevisLineContextEditor({ devisId, lineItemId, lineNumber, context, readOnly = false }: DevisLineContextEditorProps) {
  const { toast } = useToast();
  const revisionRef = useRef<number>(context?.revision ?? 0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "conflict" | "error">("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        code: false,
        codeBlock: false,
        strike: false,
        horizontalRule: false,
        underline: false,
        link: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        protocols: ["https", "mailto"],
        shouldAutoLink: (url) => isSafeContextHref(url),
      }),
      buildContextImageNode(devisId),
    ],
    [devisId],
  );

  // --- Single-flight save queue -------------------------------------------
  // Saves are serialized: at most one PUT in flight; while it runs, newer
  // snapshots coalesce into `pendingDocRef` (only the latest is kept). On a
  // 409 we rebase ONCE onto the server's latest revision and retry with the
  // user's content preserved (deliberate last-writer-wins with a notice);
  // a second consecutive 409 surfaces the conflict instead of looping.
  const pendingDocRef = useRef<ContextDoc | null>(null);
  const inFlightRef = useRef(false);
  const rebasedRef = useRef(false);

  const putDocument = async (document: ContextDoc): Promise<DevisLineContext> => {
    const res = await fetch(`/api/devis/${devisId}/line-contexts/${lineItemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ document, baseRevision: revisionRef.current }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: res.statusText }));
      const err = new Error(body.message || "Save failed") as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as DevisLineContext;
  };

  const fetchLatestRevision = async (): Promise<number> => {
    const res = await fetch(`/api/devis/${devisId}/line-contexts`, { credentials: "include" });
    if (!res.ok) throw new Error("Could not reload context state");
    const body = (await res.json()) as { contexts: DevisLineContext[] };
    return body.contexts.find((c) => c.devisLineItemId === lineItemId)?.revision ?? 0;
  };

  const pumpSaves = async () => {
    if (inFlightRef.current) return;
    const doc = pendingDocRef.current;
    if (!doc) return;
    pendingDocRef.current = null;
    inFlightRef.current = true;
    setSaveState("saving");
    try {
      const saved = await putDocument(doc);
      revisionRef.current = saved.revision;
      rebasedRef.current = false;
      setSaveState("saved");
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status === 409 && !rebasedRef.current) {
        rebasedRef.current = true;
        try {
          revisionRef.current = await fetchLatestRevision();
          // Retry with the user's content unless they typed something newer.
          if (!pendingDocRef.current) pendingDocRef.current = doc;
          toast({
            title: "Context edited elsewhere",
            description: "This line was updated in another window — your version is being saved over it.",
          });
        } catch {
          setSaveState("error");
        }
      } else if (status === 409) {
        rebasedRef.current = false;
        setSaveState("conflict");
        queryClient.invalidateQueries({ queryKey: ["/api/devis", devisId, "line-contexts"] });
        toast({
          title: "Context changed elsewhere",
          description: "This line's context keeps changing in another window. Reload the page before editing further.",
          variant: "destructive",
        });
      } else {
        setSaveState("error");
        toast({
          title: "Context save failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      }
    } finally {
      inFlightRef.current = false;
      if (pendingDocRef.current) void pumpSaves();
    }
  };

  const enqueueFromEditor = (editor: Editor) => {
    const doc = normalizeEditorJson(editor.getJSON() as EditorJsonNode);
    // Don't create a row for a line whose context was never used.
    if (revisionRef.current === 0 && isContextDocEmpty(doc) && !pendingDocRef.current) return;
    const check = contextDocSchema.safeParse(doc);
    if (!check.success) {
      setSaveState("error");
      toast({
        title: "Context not saved",
        description: check.error.issues[0]?.message ?? "Invalid content",
        variant: "destructive",
      });
      return;
    }
    pendingDocRef.current = check.data;
    void pumpSaves();
  };

  const scheduleSave = (editor: Editor, immediate = false) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (immediate) enqueueFromEditor(editor);
    else debounceRef.current = setTimeout(() => enqueueFromEditor(editor), 1500);
  };

  const uploadImage = async (editor: Editor, file: File) => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast({ title: "Unsupported image", description: "Only PNG, JPEG and WebP images are accepted.", variant: "destructive" });
      return;
    }
    if (file.size > CONTEXT_ASSET_MAX_BYTES) {
      toast({ title: "Image too large", description: "Images must be 5 MB or smaller.", variant: "destructive" });
      return;
    }
    try {
      const res = await fetch(`/api/devis/${devisId}/line-contexts/${lineItemId}/assets`, {
        method: "POST",
        headers: { "Content-Type": file.type },
        credentials: "include",
        body: file,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(body.message || "Upload failed");
      }
      const asset = (await res.json()) as { id: number };
      editor.chain().focus().insertContent({ type: "image", attrs: { assetId: asset.id } }).run();
      scheduleSave(editor, true);
    } catch (err) {
      toast({
        title: "Image upload failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  };

  const editor = useEditor(
    {
      extensions,
      editable: !readOnly,
      content: (context?.document as ContextDoc | undefined) ?? { type: "doc", content: [] },
      editorProps: {
        attributes: {
          class:
            "ctx-editor min-h-[44px] w-full rounded-md border border-input bg-background px-3 py-2 text-[11px] leading-snug focus:outline-none focus:ring-1 focus:ring-ring prose-sm max-w-none",
          "data-testid": `input-context-${devisId}-${lineNumber}`,
        },
        handlePaste: (_view, event) => {
          const items = Array.from(event.clipboardData?.items ?? []);
          const imageItem = items.find((i) => i.type.startsWith("image/"));
          if (imageItem && editor) {
            const file = imageItem.getAsFile();
            if (file) {
              event.preventDefault();
              void uploadImage(editor, file);
              return true;
            }
          }
          return false;
        },
      },
      onUpdate: ({ editor: e }) => {
        setSaveState("idle");
        scheduleSave(e as Editor);
      },
      onBlur: ({ editor: e }) => scheduleSave(e as Editor, true),
    },
    [devisId, lineItemId],
  );

  // Flush a pending debounced save on unmount so navigating away within the
  // debounce window doesn't silently drop the edit.
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor ?? null;
  const enqueueRef = useRef(enqueueFromEditor);
  enqueueRef.current = enqueueFromEditor;
  useEffect(
    () => () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        if (editorRef.current && !editorRef.current.isDestroyed) {
          enqueueRef.current(editorRef.current);
        }
      }
    },
    [],
  );

  if (!editor) return null;

  if (readOnly) {
    // Finalised: no toolbar, no autosave — just the (non-editable) content.
    if (!context || isContextDocEmpty(context.document as ContextDoc)) return null;
    return (
      <div className="space-y-1" data-testid={`section-context-${devisId}-${lineNumber}`}>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Context (shown in the translated PDF)
        </div>
        <EditorContent editor={editor} />
      </div>
    );
  }

  const setLink = () => {
    const previous = (editor.getAttributes("link").href as string | undefined) ?? "";
    const url = window.prompt("Link URL (https:// or mailto:)", previous);
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().unsetLink().run();
      scheduleSave(editor, true);
      return;
    }
    const normalized = /^(https:\/\/|mailto:)/i.test(url) ? url : `https://${url}`;
    if (!isSafeContextHref(normalized)) {
      toast({ title: "Invalid link", description: "Only https:// and mailto: links are allowed.", variant: "destructive" });
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: normalized }).run();
    scheduleSave(editor, true);
  };

  const toolbarButton = (
    active: boolean,
    onClick: () => void,
    label: string,
    icon: React.ReactNode,
    testId: string,
  ) => (
    <Button
      type="button"
      size="icon"
      variant={active ? "secondary" : "ghost"}
      className="h-6 w-6"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={label}
      data-testid={testId}
    >
      {icon}
    </Button>
  );

  return (
    <div className="space-y-1" data-testid={`section-context-${devisId}-${lineNumber}`}>
      <div className="flex items-center gap-1">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Context (shown in the translated PDF)
        </div>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground" data-testid={`status-context-save-${devisId}-${lineNumber}`}>
          {saveState === "saving" && (<><Loader2 className="h-3 w-3 animate-spin" /> Saving…</>)}
          {saveState === "saved" && (<><Check className="h-3 w-3 text-emerald-600" /> Saved</>)}
          {saveState === "conflict" && (<><AlertTriangle className="h-3 w-3 text-destructive" /> Edited elsewhere</>)}
          {saveState === "error" && (<><AlertTriangle className="h-3 w-3 text-destructive" /> Not saved</>)}
        </span>
      </div>
      <div className="flex items-center gap-0.5">
        {toolbarButton(editor.isActive("bold"), () => { editor.chain().focus().toggleBold().run(); }, "Bold", <Bold className="h-3 w-3" />, `button-context-bold-${devisId}-${lineNumber}`)}
        {toolbarButton(editor.isActive("italic"), () => { editor.chain().focus().toggleItalic().run(); }, "Italic", <Italic className="h-3 w-3" />, `button-context-italic-${devisId}-${lineNumber}`)}
        {toolbarButton(editor.isActive("bulletList"), () => { editor.chain().focus().toggleBulletList().run(); }, "Bullet list", <List className="h-3 w-3" />, `button-context-bullets-${devisId}-${lineNumber}`)}
        {toolbarButton(editor.isActive("orderedList"), () => { editor.chain().focus().toggleOrderedList().run(); }, "Numbered list", <ListOrdered className="h-3 w-3" />, `button-context-numbers-${devisId}-${lineNumber}`)}
        {toolbarButton(editor.isActive("link"), setLink, "Add link (https or mailto)", <LinkIcon className="h-3 w-3" />, `button-context-link-${devisId}-${lineNumber}`)}
        {toolbarButton(false, () => fileInputRef.current?.click(), "Insert image (PNG, JPEG, WebP — or paste one)", <ImageIcon className="h-3 w-3" />, `button-context-image-${devisId}-${lineNumber}`)}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void uploadImage(editor, file);
            e.target.value = "";
          }}
          data-testid={`input-context-file-${devisId}-${lineNumber}`}
        />
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
