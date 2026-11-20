// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import JobsJotter from "../JobsJotter";

const request = vi.fn();
const initial = { content: "Check door schedule", revision: 3, updatedAt: null };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" },
});
const settle = async () => { await act(async () => {}); };
const debounce = async () => {
  await act(async () => { await vi.advanceTimersByTimeAsync(701); });
};
const editor = () => screen.getByRole("textbox", { name: /Your personal Jobs notes/ });
const change = (text: string) => fireEvent.change(editor(), { target: { value: text } });
const writes = () => request.mock.calls.filter(([, options]) => options.method === "PUT");

async function openPad() {
  render(<JobsJotter />);
  fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  request.mockReset();
  request.mockResolvedValueOnce(response(initial));
  vi.stubGlobal("fetch", request);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Browser storage must not be used"); });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Jobs personal jotter", () => {
  it("loads the personal pad and serialises edits made during an in-flight save", async () => {
    let finish!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    request.mockResolvedValueOnce(response({ ...initial, content: "Latest draft", revision: 5 }));
    await openPad();
    expect(editor()).toHaveValue(initial.content);
    change("First draft");
    await debounce();
    expect(screen.getByRole("status")).toHaveTextContent("Saving");
    change("Latest draft");
    await debounce();
    expect(writes()).toHaveLength(1);
    await act(async () => { finish(response({ ...initial, content: "First draft", revision: 4 })); });
    expect(writes()).toHaveLength(2);
    expect(JSON.parse(writes()[1][1].body)).toEqual({ content: "Latest draft", revision: 4 });
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(editor()).toHaveValue("Latest draft");
    expect(writes()[0][1].credentials).toBe("include");
  });

  it("flushes on close without deleting and retains the draft while hidden", async () => {
    let finish!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    await openPad();
    change("Keep this note");
    fireEvent.click(screen.getByRole("button", { name: "Close Jobs — keep notes" }));
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body).content).toBe("Keep this note");
    expect(screen.queryByRole("region", { name: "Jobs" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Jobs/ }));
    expect(editor()).toHaveValue("Keep this note");
    await act(async () => { finish(response({ ...initial, content: "Keep this note", revision: 4 })); });
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("preserves both versions on conflict and requires explicit review before a version-guarded save", async () => {
    const remote = { ...initial, content: "Other tab's note", revision: 8 };
    request.mockResolvedValueOnce(response({ message: "Conflict", current: remote }, 409));
    request.mockResolvedValueOnce(response({ ...remote, content: "My draft\nOther tab's note", revision: 9 }));
    await openPad();
    change("My draft");
    await debounce();
    expect(editor()).toHaveValue("My draft");
    expect(screen.getByLabelText("Saved version from the other tab")).toHaveValue(remote.content);
    expect(screen.getByRole("button", { name: "Save reviewed version" })).toBeDisabled();
    change("My draft\nOther tab's note");
    await debounce();
    expect(writes()).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed version" }));
    await settle();
    expect(JSON.parse(writes()[1][1].body)).toEqual({ content: "My draft\nOther tab's note", revision: 8 });
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("keeps failed drafts, warns before unload and retries with the original revision", async () => {
    request.mockRejectedValueOnce(new TypeError("Offline"));
    request.mockResolvedValueOnce(response({ ...initial, content: "Retain me", revision: 4 }));
    await openPad();
    change("Retain me");
    const warning = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(warning);
    expect(warning.defaultPrevented).toBe(true);
    await debounce();
    expect(editor()).toHaveValue("Retain me");
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved");
    change("Retain me");
    await debounce();
    expect(writes()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await settle();
    expect(JSON.parse(writes()[1][1].body).revision).toBe(3);
    const savedWarning = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(savedWarning);
    expect(savedWarning.defaultPrevented).toBe(false);
  });

  it("only deletes after confirmation and persists an empty string", async () => {
    request.mockResolvedValueOnce(response({ ...initial, content: "", revision: 4 }));
    await openPad();
    fireEvent.click(screen.getByRole("button", { name: "Delete all notes" }));
    expect(writes()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Keep notes" }));
    expect(editor()).toHaveValue(initial.content);
    fireEvent.click(screen.getByRole("button", { name: "Delete all notes" }));
    const confirmation = screen.getByRole("group", { name: "Confirm deletion of all Jobs notes" });
    fireEvent.click(confirmation.querySelector("button")!);
    await settle();
    expect(JSON.parse(writes()[0][1].body)).toEqual({ content: "", revision: 3 });
    expect(editor()).toHaveValue("");
  });

  it("offers loading retry and never enables editing before the saved revision is known", async () => {
    request.mockReset();
    request.mockRejectedValueOnce(new TypeError("Offline"));
    request.mockResolvedValueOnce(response(initial));
    await openPad();
    expect(editor()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
    await settle();
    expect(editor()).toBeEnabled();
    expect(editor()).toHaveValue(initial.content);
  });

  it("does not call a reverted draft saved after an uncertain network failure", async () => {
    let fail!: (reason: Error) => void;
    request.mockImplementationOnce(() => new Promise<Response>((_, reject) => { fail = reject; }));
    request.mockResolvedValueOnce(response({ ...initial, revision: 4 }));
    await openPad();
    change("Possibly committed on the server");
    await debounce();
    change(initial.content);
    await act(async () => { fail(new TypeError("Connection lost after commit")); });
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved");
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await settle();
    expect(writes()).toHaveLength(2);
    expect(JSON.parse(writes()[1][1].body)).toEqual({ content: initial.content, revision: 3 });
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("preserves a remote note when a confirmed deletion encounters a conflict", async () => {
    request.mockResolvedValueOnce(response({
      message: "Conflict", current: { ...initial, content: "New remote note", revision: 4 },
    }, 409));
    await openPad();
    fireEvent.click(screen.getByRole("button", { name: "Delete all notes" }));
    const confirmation = screen.getByRole("group", { name: "Confirm deletion of all Jobs notes" });
    fireEvent.click(confirmation.querySelector("button")!);
    await settle();
    expect(editor()).toHaveValue("");
    expect(screen.getByLabelText("Saved version from the other tab")).toHaveValue("New remote note");
    expect(screen.getByRole("button", { name: "Save reviewed version" })).toBeDisabled();
    await debounce();
    expect(writes()).toHaveLength(1);
  });
});
