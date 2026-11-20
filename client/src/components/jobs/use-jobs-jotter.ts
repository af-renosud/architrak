import { useEffect, useRef, useState } from "react";
import { ApiError, apiRequest } from "@/lib/queryClient";

export interface JotterRecord {
  content: string;
  revision: number;
  updatedAt: string | null;
}

interface JotterState {
  content: string;
  saved: JotterRecord | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  conflict: JotterRecord | null;
}

export const JOBS_MAX_LENGTH = 100000;

function isRecord(value: unknown): value is JotterRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as JotterRecord;
  return typeof item.content === "string" && Number.isInteger(item.revision) &&
    item.revision >= 0 && (item.updatedAt === null || typeof item.updatedAt === "string");
}

export function useJobsJotter() {
  const [state, setState] = useState<JotterState>({
    content: "", saved: null, loading: true, saving: false, error: null, conflict: null,
  });
  const current = useRef(state);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(false);
  const loadSequence = useRef(0);
  const inFlight = useRef(false);

  function patch(change: Partial<JotterState>) {
    current.current = { ...current.current, ...change };
    if (mounted.current) setState(current.current);
  }

  function cancelTimer() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  }

  async function load() {
    const sequence = ++loadSequence.current;
    patch({ loading: true, error: null });
    try {
      const value: unknown = await (await apiRequest("GET", "/api/jobs-jotter")).json();
      if (sequence !== loadSequence.current || !mounted.current) return;
      if (!isRecord(value)) throw new Error("Invalid response");
      patch({ content: value.content, saved: value, loading: false });
    } catch {
      if (sequence === loadSequence.current && mounted.current) {
        patch({ loading: false, error: "Your notes could not be loaded. Retry before editing." });
      }
    }
  }

  // A single writer drains the latest draft. Edits during a PUT never start
  // another request; they are picked up using the newly returned revision.
  async function flush() {
    cancelTimer();
    if (inFlight.current || !current.current.saved || current.current.conflict) return;
    inFlight.current = true;
    // A failed response may follow a committed write. Even if the user has
    // reverted to the old baseline, verify it with a guarded PUT on retry.
    let verifyFailedWrite = !!current.current.error;
    patch({ error: null });
    try {
      while (mounted.current && current.current.saved &&
        (verifyFailedWrite || current.current.content !== current.current.saved.content)) {
        verifyFailedWrite = false;
        const content = current.current.content;
        const revision = current.current.saved.revision;
        patch({ saving: true });
        try {
          const value: unknown = await (await apiRequest("PUT", "/api/jobs-jotter", { content, revision })).json();
          if (!isRecord(value)) throw new Error("Invalid response");
          patch({ saved: value });
        } catch (error) {
          const remote = error instanceof ApiError && error.status === 409 &&
            error.data && typeof error.data === "object" && "current" in error.data
            ? error.data.current : null;
          if (isRecord(remote)) {
            patch({ conflict: remote, error: null });
          } else {
            patch({ error: "Your latest changes have not been saved. Keep this page open and retry." });
          }
          break;
        }
      }
    } finally {
      inFlight.current = false;
      patch({ saving: false });
    }
  }

  function edit(content: string) {
    if (!current.current.saved || content.length > JOBS_MAX_LENGTH) return;
    patch({ content });
    cancelTimer();
    if (!current.current.conflict && !current.current.error) {
      timer.current = setTimeout(() => { void flush(); }, 700);
    }
  }

  function saveReviewed() {
    const remote = current.current.conflict;
    if (!remote) return;
    // The user has explicitly reviewed the remote copy and edited their draft.
    // A further remote change will produce another 409, never an unguarded PUT.
    patch({ saved: remote, conflict: null, error: null });
    void flush();
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    const warn = (event: BeforeUnloadEvent) => {
      const value = current.current;
      if (inFlight.current || value.conflict || (value.saved && (value.error || value.content !== value.saved.content))) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      mounted.current = false;
      ++loadSequence.current;
      cancelTimer();
      window.removeEventListener("beforeunload", warn);
    };
  }, []);

  const dirty = !!state.saved && state.content !== state.saved.content;
  return {
    ...state, dirty, edit, flush, reload: load, saveReviewed,
    retry: () => state.saved ? void flush() : void load(),
  };
}
