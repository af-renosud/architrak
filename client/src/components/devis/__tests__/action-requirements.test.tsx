// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { BlockedAction } from "@/components/ui/blocked-action";
import { Tabs } from "@/components/ui/tabs";
import { DevisWorkflow, PreservedTabsContent, WorkflowSection } from "../DevisWorkflow";
import { fetchOpenQuotationChecks, goToQuotationTarget, quotationRequirement, readinessRequirements, stageRequirements } from "../action-requirements";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", window.clearTimeout.bind(window));
  Element.prototype.scrollIntoView = vi.fn();
});

describe("explainable financial actions", () => {
  it("blocks missing-data clicks without calling a mutation; resolving does not autosubmit", async () => {
    const mutate = vi.fn();
    const missing = { id: 42, lotId: null, lotRefText: "  ", descriptionUk: "" };
    const view = render(<BlockedAction actionLabel="Before approval" requirements={stageRequirements(missing)} onClick={mutate}>Approve quotation</BlockedAction>);
    fireEvent.click(screen.getByRole("button", { name: "Approve quotation" }));
    expect(screen.getByText("Assign a lot or save a lot reference.")).toBeVisible();
    expect(screen.getByText("Save an English works description.")).toBeVisible();
    expect(mutate).not.toHaveBeenCalled();
    view.rerender(<BlockedAction actionLabel="Before approval" requirements={stageRequirements({ ...missing, lotRefText: "FD", descriptionUk: "Facade" })} onClick={mutate}>Approve quotation</BlockedAction>);
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Approve quotation" }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });
  it("explains from the keyboard, supports Escape, and never runs a blocked action", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    render(<BlockedAction actionLabel="Before approval" requirements={stageRequirements({ id: 42 })} onClick={mutate}>Approve quotation</BlockedAction>);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByText("Before approval")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Before approval")).toBeNull();
    expect(screen.getByRole("button", { name: "Approve quotation" })).toHaveFocus();
    await user.keyboard(" ");
    expect(screen.getByText("Before approval")).toBeVisible();
    expect(mutate).not.toHaveBeenCalled();
  });
  it("explains from a touch-generated click and keeps busy actions genuinely disabled", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    const view = render(<BlockedAction actionLabel="Before approval" requirements={stageRequirements({ id: 42 })} onClick={mutate}>Approve quotation</BlockedAction>);
    await user.pointer([{ keys: "[TouchA>]", target: screen.getByRole("button", { name: "Approve quotation" }) }, { keys: "[/TouchA]" }]);
    expect(screen.getByText("Before approval")).toBeVisible();
    view.rerender(<BlockedAction actionLabel="Before approval" disabled requirements={[]} onClick={mutate}>Approve quotation</BlockedAction>);
    expect(screen.getByRole("button", { name: "Approve quotation" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Approve quotation" }));
    expect(mutate).not.toHaveBeenCalled();
  });
  it("reveals an exact hidden field, focuses and outlines it without discarding the draft", async () => {
    function Fixture() {
      const [draft, setDraft] = useState("Unsaved wording");
      return <DevisWorkflow devisId={42} stage="approved_for_signing">
        <BlockedAction actionLabel="Before sending" requirements={[quotationRequirement("description", "An English description is required.", 42)]}>Send</BlockedAction>
        <WorkflowSection group="review" summary="Source"><input data-testid="input-description-uk-42" value={draft} onChange={event => setDraft(event.target.value)} /></WorkflowSection>
      </DevisWorkflow>;
    }
    render(<Fixture />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to English description" }));
    const field = await screen.findByTestId("input-description-uk-42");
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveClass("blocked-action-target");
    expect(field).toHaveValue("Unsaved wording");
  });
  it("reuses lazy section and tab events to reveal the translation panel", async () => {
    function Package() {
      const [tab, setTab] = useState("lines");
      useEffect(() => {
        const reveal = (event: Event) => setTab((event as CustomEvent<{ tab: string }>).detail.tab);
        window.addEventListener("architrak:workflow-tab", reveal);
        return () => window.removeEventListener("architrak:workflow-tab", reveal);
      }, []);
      return <Tabs value={tab}><PreservedTabsContent activeTab={tab} value="translation"><div data-testid="section-translation-42">Translated PDF</div></PreservedTabsContent></Tabs>;
    }
    render(<DevisWorkflow devisId={42} stage="received"><WorkflowSection group="prepare" summary="Package"><Package /></WorkflowSection></DevisWorkflow>);
    goToQuotationTarget(42, "translation");
    await waitFor(() => expect(screen.getByTestId("section-translation-42")).toHaveFocus());
  });
  it("separates waiting and unavailable explanations and exposes a retry, never the action", () => {
    const mutate = vi.fn(), retry = vi.fn();
    const view = render(<BlockedAction actionLabel="Before sending" requirements={[{ id: "checks", kind: "waiting", message: "Checking contractor questions." }]} onClick={mutate}>Send</BlockedAction>);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByText("Waiting:")).toBeVisible();
    view.rerender(<BlockedAction actionLabel="Before sending" requirements={[{ id: "checks", kind: "technical", message: "Clearance is unknown.", onResolve: retry, linkLabel: "Retry checks" }]} onClick={mutate}>Send</BlockedAction>);
    expect(screen.getByText("Unavailable:")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry checks" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("quotation requirement definitions", () => {
  it("accepts persisted lotId OR trimmed lotRefText, and checks description independently", () => {
    expect(stageRequirements({ id: 42, lotId: 17, descriptionUk: "Facade" })).toEqual([]);
    expect(stageRequirements({ id: 42, lotRefText: " FD ", descriptionUk: "Facade" })).toEqual([]);
    expect(stageRequirements({ id: 42, lotRefText: "  ", descriptionUk: " " }).map(item => item.id)).toEqual(["lot", "description"]);
    // Internal check / approval requirements deliberately contain neither translation nor questions.
    expect(stageRequirements({ id: 42, lotId: 17, descriptionUk: "Facade" })).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "translation" })]));
  });
  it("maps the current server contract to typed destinations without inventing links for unknown blockers", () => {
    const requirements = readinessRequirements(["Lot reference missing", "English description missing", "Translated PDF not generated (currently missing)", "2 contractor checks are still open", "Client contact name/email missing on the project", "A future server safeguard"], 42, 9);
    expect(requirements.map(item => item.id)).toEqual(["lot", "description", "translation", "checks", "contact", "server-5"]);
    expect(requirements.at(-1)?.onResolve).toBeUndefined();
    const listener = vi.fn();
    window.addEventListener("architrak:edit-project-contact", listener);
    requirements[4].onResolve?.();
    expect(listener.mock.calls[0][0].detail).toEqual({ projectId: 9 });
    window.removeEventListener("architrak:edit-project-contact", listener);
  });
  it("throws on failed or malformed open-check requests rather than reporting zero", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetch);
    await expect(fetchOpenQuotationChecks(42)).rejects.toThrow("unavailable");
    fetch.mockResolvedValue({ ok: true, json: async () => ({ status: "error" }) });
    await expect(fetchOpenQuotationChecks(42)).rejects.toThrow("unavailable");
    fetch.mockResolvedValue({ ok: true, json: async () => [{ status: "open" }, { status: "awaiting_contractor" }, { status: "awaiting_architect" }, { status: "resolved" }] });
    await expect(fetchOpenQuotationChecks(42)).resolves.toBe(3);
    expect(fetch).toHaveBeenCalledWith("/api/devis/42/checks", { credentials: "include" });
  });
});
