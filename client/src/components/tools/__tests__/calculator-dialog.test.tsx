// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/layout/Sidebar";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, logout: vi.fn() }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
}));
vi.mock("@/components/layout/NotificationBell", () => ({
  NotificationBell: () => <button type="button">Notifications</button>,
}));

afterEach(cleanup);

function setup() {
  const onMobileClose = vi.fn();
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <Sidebar mobileMode mobileOpen onMobileClose={onMobileClose} />
    </TooltipProvider>,
  );
  return { user, onMobileClose };
}

describe("sidebar calculator", () => {
  it("places a single tool above Settings and preserves mobile navigation on close", async () => {
    const { user, onMobileClose } = setup();
    const trigger = screen.getByRole("button", { name: "Ouvrir la calculatrice" });
    const tools = screen.getByTestId("nav-utilities");
    const settings = screen.getByTestId("link-nav-settings");
    expect(within(tools).getAllByRole("button")).toHaveLength(1);
    expect(tools.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(trigger);
    const panel = screen.getByTestId("calculator-dialog");
    expect(panel.getAttribute("role")).toBe("dialog");
    await user.keyboard("12+3{Enter}");
    expect(screen.getByTestId("calculator-display").textContent).toBe("15");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("calculator-dialog")).toBeNull());
    expect(onMobileClose).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    screen.getByRole("button", { name: "Close navigation" }).focus();
    await user.keyboard("{Escape}");
    expect(onMobileClose).toHaveBeenCalledOnce();
  });

  it("keeps Tab inside the calculator instead of the mobile sidebar", async () => {
    const { user, onMobileClose } = setup();
    await user.click(screen.getByRole("button", { name: "Ouvrir la calculatrice" }));
    const panel = screen.getByTestId("calculator-dialog");
    const close = within(panel).getByRole("button", { name: "Fermer la calculatrice" });
    close.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Calculer" }));
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.click(close);
    await waitFor(() => expect(screen.queryByTestId("calculator-dialog")).toBeNull());
    expect(onMobileClose).not.toHaveBeenCalled();
  });

  it("supports button input, copy feedback and clipboard failure", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Ouvrir la calculatrice" }));
    const panel = screen.getByTestId("calculator-dialog");
    for (const name of ["7", "Multiplier", "6", "Calculer"]) {
      await user.click(within(panel).getByRole("button", { name }));
    }
    expect(screen.getByTestId("calculator-display").textContent).toBe("42");
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(within(panel).getByRole("button", { name: "Copier le résultat" }));
    expect(writeText).toHaveBeenCalledWith("42");
    expect(screen.getByText("Résultat copié")).toBeTruthy();
    writeText.mockRejectedValueOnce(new Error("denied"));
    await user.click(within(panel).getByRole("button", { name: "Copier le résultat" }));
    expect(screen.getByText(/Copie indisponible/)).toBeTruthy();
    writeText.mockRestore();
  });
});
