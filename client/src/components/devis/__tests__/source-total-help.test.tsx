// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { SourceTotalHelp } from "../SourceTotalHelp";

afterEach(() => { cleanup(); vi.useRealTimers(); });
it.each(["hover", "focus", "click"])("opens source explanation on %s without requiring a tooltip", async interaction => {
  render(<SourceTotalHelp />);
  const trigger = screen.getByRole("button", { name: "Why am I seeing this?" });
  if (interaction === "hover") fireEvent.mouseEnter(trigger);
  else if (interaction === "focus") fireEvent.focus(trigger);
  else fireEvent.click(trigger);
  expect(await screen.findByText("Confirm the original, not a new total")).toBeVisible();
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText(/does not change the original PDF or automatically balance/)).toBeVisible();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});
it.each(["difference", "missing"] as const)("explains %s for hover, focus and click without hiding the essential check", async kind => {
  render(<SourceTotalHelp kind={kind} />);
  const trigger = screen.getByRole("button", { name: "Why am I seeing this?" });
  for (const interaction of ["hover", "focus", "click"]) {
    if (interaction === "hover") fireEvent.mouseEnter(trigger);
    else if (interaction === "focus") fireEvent.focus(trigger);
    else fireEvent.click(trigger);
    const panel = await screen.findByRole("dialog", { name: kind === "difference" ? "The working figures differ" : "Financial information is missing" });
    expect(panel).toHaveTextContent(kind === "difference" ? "actual discrepancy" : "does not by itself prove");
    expect(panel).toHaveTextContent(kind === "difference" ? "confirming it does not adjust them" : "No VAT rate is assumed");
    fireEvent.keyDown(panel, { key: "Escape" });
    fireEvent.blur(trigger);
  }
});
it("keeps hover help open across the trigger-to-panel gap, then closes when leaving both", () => {
  vi.useFakeTimers();
  render(<SourceTotalHelp kind="difference" />);
  const trigger = screen.getByRole("button");
  fireEvent.mouseEnter(trigger);
  const panel = screen.getByRole("dialog");
  fireEvent.mouseLeave(trigger);
  act(() => { vi.advanceTimersByTime(90); });
  fireEvent.mouseEnter(panel);
  act(() => { vi.advanceTimersByTime(250); });
  expect(panel).toBeVisible();
  fireEvent.mouseLeave(panel);
  act(() => { vi.advanceTimersByTime(200); });
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("dismisses click/touch help with outside interaction and Escape without reopening on restored focus", async () => {
  const user = userEvent.setup();
  render(<><SourceTotalHelp kind="missing" /><button type="button">Elsewhere</button></>);
  const trigger = screen.getByRole("button", { name: "Why am I seeing this?" });
  await user.click(trigger);
  expect(screen.getByRole("dialog")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Elsewhere" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});
