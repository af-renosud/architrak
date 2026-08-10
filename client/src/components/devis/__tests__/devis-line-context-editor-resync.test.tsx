// @vitest-environment jsdom
//
// Regression guard for the server re-sync in DevisLineContextEditor
// (tab-switch persistence work, follow-up to Task 364).
//
// Two behaviours are locked in:
//
//  1. RACE: a fresher server snapshot (higher revision) arriving while the
//     user's edit is still waiting in the 1.5s debounce window must NOT
//     replace the editor content — the debounced save must flush the typed
//     content afterwards. (Pre-fix, the re-sync guard ignored the debounce
//     window: server content overwrote the edit and the scheduled save then
//     persisted the overwrite, losing the typed text irrecoverably.)
//
//  2. HAPPY PATH: with no local edit in progress, a fresher snapshot IS
//     applied (remount-after-tab-switch raced an unmount flush), and the
//     save baseline adopts the server revision so the next save doesn't
//     falsely 409 as "edited elsewhere".
//
// TipTap's real editor can't be typed into from jsdom, so @tiptap/react is
// mocked with a controllable fake editor; useContextSaveQueue and the
// component wiring under test are real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DevisLineContext } from "@shared/schema";

type FakeEditor = {
  doc: unknown;
  isDestroyed: boolean;
  isFocused: boolean;
  getJSON: () => unknown;
  commands: { setContent: (doc: unknown, opts?: unknown) => void };
  isActive: () => boolean;
  getAttributes: () => Record<string, unknown>;
  chain: () => unknown;
};

let fakeEditor: FakeEditor;
let editorConfig: {
  onUpdate?: (p: { editor: unknown }) => void;
  onBlur?: (p: { editor: unknown }) => void;
} = {};
const setContentCalls: unknown[] = [];

function makeFakeEditor(initialDoc: unknown): FakeEditor {
  const chainStub: Record<string, unknown> = {};
  const chain = () => new Proxy(chainStub, { get: (_t, p) => (p === "run" ? () => true : chain) });
  return {
    doc: initialDoc,
    isDestroyed: false,
    isFocused: false,
    getJSON() {
      return this.doc;
    },
    commands: {
      setContent(doc: unknown) {
        fakeEditor.doc = doc;
        setContentCalls.push(doc);
      },
    },
    isActive: () => false,
    getAttributes: () => ({}),
    chain,
  };
}

vi.mock("@tiptap/react", () => ({
  useEditor: (cfg: typeof editorConfig) => {
    editorConfig = cfg;
    return fakeEditor;
  },
  EditorContent: () => <div data-testid="fake-editor-content" />,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { DevisLineContextEditor } from "../DevisLineContextEditor";

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const ctx = (revision: number, text: string): DevisLineContext =>
  ({
    id: 1,
    devisId: 42,
    devisLineItemId: 100,
    revision,
    document: doc(text),
  }) as unknown as DevisLineContext;

const fetchMock = vi.fn();

function renderEditor(context: DevisLineContext | null) {
  return render(
    <DevisLineContextEditor devisId={42} lineItemId={100} lineNumber={1} context={context} />,
  );
}

describe("DevisLineContextEditor server re-sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setContentCalls.length = 0;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not wipe an edit waiting in the debounce window when a fresher snapshot arrives", async () => {
    fakeEditor = makeFakeEditor(doc("Server v1"));
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      // PUT save: echo the sent document back with a bumped revision.
      const body = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({ id: 1, devisId: 42, devisLineItemId: 100, revision: 3, document: body.document }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const view = renderEditor(ctx(1, "Server v1"));

    // User types: editor content changes, onUpdate arms the 1.5s debounce.
    // Focus is already gone (e.g. programmatic blur / focus tracking lag) —
    // the debounce window itself must protect the edit.
    act(() => {
      fakeEditor.doc = doc("User typed text");
      editorConfig.onUpdate!({ editor: fakeEditor });
    });

    // A fresher server snapshot (rev 2) arrives before the debounce fires.
    view.rerender(
      <DevisLineContextEditor devisId={42} lineItemId={100} lineNumber={1} context={ctx(2, "Fresher server doc")} />,
    );

    // Guard must have refused the overwrite.
    expect(setContentCalls).toHaveLength(0);
    expect(JSON.stringify(fakeEditor.doc)).toContain("User typed text");

    // Debounce fires → the TYPED content is saved.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    const putCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PUT");
    expect(putCall, "expected a PUT save").toBeDefined();
    expect((putCall![1] as RequestInit).body as string).toContain("User typed text");

    // After the save settles, the now-older rev-2 snapshot must still not
    // replace the just-saved content (revision baseline moved to 3).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(setContentCalls).toHaveLength(0);
    expect(JSON.stringify(fakeEditor.doc)).toContain("User typed text");
  });

  it("applies a fresher snapshot when idle and adopts its revision as the save baseline", async () => {
    fakeEditor = makeFakeEditor(doc("")); // remounted from a stale/empty cache
    const putBodies: string[] = [];
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") putBodies.push(init.body as string);
      const body = init?.body ? JSON.parse(init.body as string) : {};
      return new Response(
        JSON.stringify({ id: 1, devisId: 42, devisLineItemId: 100, revision: 5, document: body.document ?? doc("x") }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const view = renderEditor(ctx(1, ""));

    // The unmount flush of the previous instance landed server-side (rev 4)
    // and the invalidated query now delivers the fresher snapshot.
    view.rerender(
      <DevisLineContextEditor devisId={42} lineItemId={100} lineNumber={1} context={ctx(4, "Flushed note")} />,
    );

    expect(setContentCalls).toHaveLength(1);
    expect(JSON.stringify(fakeEditor.doc)).toContain("Flushed note");

    // A subsequent edit saves against the ADOPTED revision (4) — not the
    // stale mount-time revision (1), which would falsely 409.
    act(() => {
      fakeEditor.doc = doc("Flushed note plus more");
      editorConfig.onUpdate!({ editor: fakeEditor });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(putBodies).toHaveLength(1);
    expect(JSON.parse(putBodies[0]).baseRevision).toBe(4);
  });
});
