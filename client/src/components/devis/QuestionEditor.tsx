import { useEffect, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { renderQuestionHtml } from "@shared/question-format";

export function QuestionEditor({ value, onChange, onBlur, disabled }: {
  value: string; onChange: (value: string) => void; onBlur: () => void; disabled: boolean;
}) {
  const change = useRef(onChange);
  change.current = onChange;
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, blockquote: false, codeBlock: false, code: false, horizontalRule: false, strike: false, link: false })],
    content: renderQuestionHtml(value),
    onUpdate: ({ editor }) => change.current(editor.isEmpty ? "" : editor.getHTML()),
  });
  useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);
  useEffect(() => {
    if (editor && !editor.isFocused && editor.getHTML() !== value) editor.commands.setContent(renderQuestionHtml(value), { emitUpdate: false });
  }, [editor, value]);
  return <div className="rounded border bg-white" onBlur={(e) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onBlur();
  }}>
    <div className="flex gap-1 border-b p-1" role="toolbar" aria-label="Question formatting">
      {[
        { label: "Bold", active: "bold", run: () => editor?.chain().focus().toggleBold().run() },
        { label: "Italic", active: "italic", run: () => editor?.chain().focus().toggleItalic().run() },
        { label: "Bullet list", active: "bulletList", run: () => editor?.chain().focus().toggleBulletList().run() },
        { label: "Numbered list", active: "orderedList", run: () => editor?.chain().focus().toggleOrderedList().run() },
      ].map(b => <button key={b.label} type="button" disabled={disabled} aria-label={b.label}
        aria-pressed={editor?.isActive(b.active)} className="rounded px-2 py-1 text-xs hover:bg-slate-100"
        onMouseDown={e => e.preventDefault()} onClick={b.run}>{b.label}</button>)}
    </div>
    <EditorContent editor={editor} className="p-3 text-sm [&_.tiptap]:min-h-28 [&_.tiptap]:outline-hidden [&_.tiptap]:focus-visible:ring-2 [&_.tiptap]:focus-visible:ring-slate-400 [&_p]:mb-2 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6" />
  </div>;
}
