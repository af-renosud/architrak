// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppLayout } from "../AppLayout";

const route = vi.hoisted(() => ({ path: "/projets/42" }));
vi.mock("wouter", async (importOriginal) => ({
  ...await importOriginal<typeof import("wouter")>(),
  useLocation: () => [route.path, vi.fn()],
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, logout: vi.fn() }),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock("../NotificationBell", () => ({ NotificationBell: () => <button>Notifications</button> }));

const key = "architrak:desktop-sidebar-collapsed";
let mobile = false;
let mediaListener: ((event: { matches: boolean }) => void) | undefined;
let mounts = 0;

function Draft() {
  const [draft, setDraft] = useState("");
  useEffect(() => { mounts += 1; }, []);
  return <input aria-label="Quotation draft" value={draft} onChange={(event) => setDraft(event.target.value)} />;
}

function setup() {
  return render(<TooltipProvider><AppLayout><Draft /></AppLayout></TooltipProvider>);
}

function resize(matches: boolean) {
  mobile = matches;
  act(() => mediaListener?.({ matches }));
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mobile = false;
  mounts = 0;
  route.path = "/projets/42";
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: mobile,
    addEventListener: (_: string, listener: typeof mediaListener) => { mediaListener = listener; },
    removeEventListener: vi.fn(),
  })));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 1));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("desktop sidebar collapse", () => {
  it("collapses fully, moves focus, reclaims the margin and preserves the mounted draft", () => {
    setup();
    const sidebar = screen.getByTestId("sidebar");
    const main = screen.getByRole("main");
    const input = screen.getByLabelText("Quotation draft");
    const collapse = screen.getByRole("button", { name: "Collapse menu" });
    expect(collapse).toHaveAttribute("title", "Collapse menu");
    expect(collapse).toHaveAttribute("aria-controls", "app-sidebar");
    expect(main).toHaveClass("lg:ml-64");
    expect(sidebar).not.toHaveAttribute("aria-hidden");
    fireEvent.change(input, { target: { value: "Unsent quotation notes" } });
    collapse.focus();
    fireEvent.click(collapse);
    const show = screen.getByRole("button", { name: "Show menu" });
    expect(show).toHaveFocus();
    expect(show).toHaveAttribute("title", "Show menu");
    expect(show).toHaveAttribute("aria-expanded", "false");
    expect(show.parentElement).toHaveClass("sticky");
    expect(main).not.toHaveClass("lg:ml-64");
    expect(sidebar).toHaveClass("lg:-translate-x-full");
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(sidebar.inert).toBe(true);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(localStorage.getItem(key)).toBe("true");
    fireEvent.click(show);
    expect(collapse).toHaveFocus();
    expect(sidebar.inert).toBe(false);
    expect(sidebar).not.toHaveAttribute("aria-hidden");
    expect(main).toHaveClass("lg:ml-64");
    expect(input).toBe(screen.getByLabelText("Quotation draft"));
    expect(input).toHaveValue("Unsent quotation notes");
    expect(mounts).toBe(1);
    expect(localStorage.getItem(key)).toBe("false");
  });

  it("restores the desktop preference after remount and keeps the reopen control reachable", () => {
    const first = setup();
    fireEvent.click(screen.getByRole("button", { name: "Collapse menu" }));
    first.unmount();
    setup();
    expect(screen.getByRole("button", { name: "Show menu" })).toBeEnabled();
    expect(screen.getByTestId("sidebar").inert).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show menu" }));
    expect(localStorage.getItem(key)).toBe("false");
  });

  it("defaults expanded for malformed preferences and survives blocked reads and writes", () => {
    localStorage.setItem(key, "invalid");
    const first = setup();
    expect(screen.getByRole("main")).toHaveClass("lg:ml-64");
    first.unmount();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    setup();
    expect(screen.getByRole("main")).toHaveClass("lg:ml-64");
    fireEvent.click(screen.getByRole("button", { name: "Collapse menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Show menu" }));
    expect(screen.getByRole("button", { name: "Collapse menu" })).toHaveFocus();
  });

  it("allows project detail routes to fill the width while retaining the cap on unrelated pages", () => {
    const view = setup();
    expect(screen.getByLabelText("Quotation draft").parentElement).not.toHaveClass("max-w-[1600px]");
    view.unmount();
    route.path = "/projets";
    setup();
    expect(screen.getByLabelText("Quotation draft").parentElement).toHaveClass("max-w-[1600px]");
  });

  it("keeps mobile drawer independent, trapped and dismissible with Escape and backdrop", () => {
    localStorage.setItem(key, "true");
    mobile = true;
    setup();
    const sidebar = screen.getByTestId("sidebar");
    expect(sidebar.inert).toBe(true);
    expect(screen.queryByRole("button", { name: "Show menu" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    act(() => { vi.advanceTimersByTime(20); });
    const close = screen.getByTestId("button-mobile-nav-close");
    expect(close).toHaveFocus();
    expect(sidebar).toHaveAttribute("aria-modal", "true");
    expect(sidebar.inert).toBe(false);
    expect(sidebar).not.toHaveAttribute("aria-hidden");
    const last = screen.getByRole("button", { name: "Notifications" });
    // The Help tool follows Notifications in the existing drawer.
    const lastButton = sidebar.querySelector<HTMLButtonElement>("[data-testid='button-tool-help']")!;
    expect(last).toBeInTheDocument();
    act(() => lastButton.focus());
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(lastButton).toHaveFocus();
    // Leave the tool tooltip before testing the drawer's Escape handler.
    act(() => close.focus());
    fireEvent.keyDown(document, { key: "Escape" });
    act(() => { vi.advanceTimersByTime(20); });
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveFocus();
    expect(sidebar.inert).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(screen.getByTestId("mobile-nav-backdrop"));
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(localStorage.getItem(key)).toBe("true");
    resize(false);
    expect(screen.getByRole("button", { name: "Show menu" })).toBeEnabled();
    expect(sidebar.inert).toBe(true);
  });

  it("keeps expanded desktop preference independent of mobile dismissal and handles breakpoint focus", () => {
    setup();
    screen.getByRole("button", { name: "Collapse menu" }).focus();
    resize(true);
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    act(() => { vi.advanceTimersByTime(20); });
    resize(false);
    expect(screen.getByRole("button", { name: "Collapse menu" })).toHaveFocus();
    expect(screen.getByTestId("sidebar").inert).toBe(false);
    expect(localStorage.getItem(key)).toBe("false");
    expect(screen.queryByTestId("mobile-nav-backdrop")).toBeNull();
  });
});
