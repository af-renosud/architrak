// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Tabs } from "@/components/ui/tabs";
import { DevisWorkflow, PreservedTabsContent, VisitedDetail, WorkflowSection } from "../DevisWorkflow";
import { initialWorkflowGroup, workflowGroups, workflowIsOpen, workflowTarget } from "../devis-workflow-model";

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Fixture({ stage = "received", status = "pending", error = "" }: { stage?: string; status?: string; error?: string }) {
  return <DevisWorkflow devisId={42} stage={stage} status={status}>
    {workflowGroups.map(group => <WorkflowSection key={group} group={group} summary="Internal status">
      <input aria-label={`${group} draft`} defaultValue="Saved value" />
      {group === "prepare" && error && <p role="alert">{error}</p>}
    </WorkflowSection>)}
  </DevisWorkflow>;
}
const heading = (name: string) => screen.getByRole("button", { name: new RegExp(name) });

describe("quotation workflow defaults and explicit navigation", () => {
  it.each([
    ["received", "pending", "review"], [null, "draft", "review"],
    ["checked_internal", "pending", "prepare"], ["approved_for_signing", "pending", "prepare"],
    ["sent_to_client", "pending", "send"], ["client_signed_off", "pending", "after"],
    ["received", "signed", "after"],
  ] as const)("chooses %s / %s as %s", (stage, status, group) => {
    expect(initialWorkflowGroup(stage, status)).toBe(group);
  });
  it("manual choices beat refreshed defaults, including explicit false", () => {
    expect(workflowIsOpen("review", "review", { review: false })).toBe(false);
    expect(workflowIsOpen("prepare", "after", { prepare: true })).toBe(true);
    const view = render(<Fixture />);
    fireEvent.click(heading("Review source"));
    fireEvent.click(heading("Prepare package"));
    fireEvent.change(screen.getByLabelText("prepare draft"), { target: { value: "Unsaved manual text" } });
    view.rerender(<Fixture stage="client_signed_off" status="signed" />);
    expect(heading("Review source")).toHaveAttribute("aria-expanded", "false");
    expect(heading("Prepare package")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("prepare draft")).toHaveValue("Unsaved manual text");
  });
  it("mounts lazily, collapses all without unmounting drafts, and expands independently", () => {
    render(<Fixture />);
    expect(screen.queryByLabelText("prepare draft")).not.toBeInTheDocument();
    fireEvent.click(heading("Prepare package"));
    fireEvent.change(screen.getByLabelText("prepare draft"), { target: { value: "Local draft" } });
    fireEvent.click(screen.getByText("Collapse all"));
    expect(screen.getByLabelText("prepare draft")).toHaveValue("Local draft");
    expect(screen.getByLabelText("prepare draft")).not.toBeVisible();
    fireEvent.click(screen.getByText("Expand all"));
    expect(screen.getByLabelText("prepare draft")).toBeVisible();
    expect(screen.getByLabelText("prepare draft")).toHaveValue("Local draft");
  });
  it("deep-link checks open send on a signed quotation and focus its heading", async () => {
    window.history.replaceState({}, "", "/projects/8?devis=42&check=117");
    render(<Fixture stage="client_signed_off" />);
    await waitFor(() => expect(heading("Send & sign")).toHaveAttribute("aria-expanded", "true"));
    await waitFor(() => expect(heading("Send & sign")).toHaveFocus());
    expect(workflowTarget("?group=prepare")).toBe("prepare");
    expect(workflowTarget("?group=unknown")).toBeNull();
  });
  it("jump navigation reveals and focuses an independent section", async () => {
    render(<Fixture />);
    fireEvent.change(screen.getByLabelText("Jump to quotation section"), { target: { value: "after" } });
    expect(heading("After signing")).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(heading("After signing")).toHaveFocus());
  });
  it("new inline errors open the right section, while a later manual collapse sticks", async () => {
    const view = render(<Fixture />);
    fireEvent.click(heading("Prepare package"));
    fireEvent.click(heading("Prepare package"));
    view.rerender(<Fixture error="Save failed; draft preserved" />);
    await waitFor(() => expect(heading("Prepare package")).toHaveAttribute("aria-expanded", "true"));
    fireEvent.click(heading("Prepare package"));
    view.rerender(<Fixture stage="sent_to_client" error="Save failed; draft preserved" />);
    expect(heading("Prepare package")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Save failed; draft preserved" })).toBeVisible();
  });
  it("replays first signing navigation only after the lazy panel mounts", async () => {
    const received = vi.fn();
    function SigningListener() {
      useEffect(() => {
        window.addEventListener("architrak:open-signing-send", received);
        return () => window.removeEventListener("architrak:open-signing-send", received);
      }, []);
      return <p>Signing controls</p>;
    }
    render(<DevisWorkflow devisId={42} stage="received">
      <WorkflowSection group="send" summary="Ready"><SigningListener /></WorkflowSection>
    </DevisWorkflow>);
    act(() => window.dispatchEvent(new CustomEvent("architrak:open-signing-send", { detail: { devisId: 42 } })));
    await waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Signing controls")).toBeVisible();
  });
});

describe("nested mount and save continuity", () => {
  it("preserves draft and asynchronous save ownership through group and outer collapse", async () => {
    let finish: (() => void) | undefined;
    const unmount = vi.fn();
    function Draft() {
      const [text, setText] = useState("Initial");
      const [saved, setSaved] = useState("");
      useEffect(() => () => unmount(), []);
      return <><input aria-label="Editor draft" value={text} onChange={event => setText(event.target.value)} />
        <button onClick={() => { const submitted = text; finish = () => setSaved(submitted); }}>Save draft</button>
        <output>{saved}</output></>;
    }
    function Editor({ open }: { open: boolean }) {
      return <VisitedDetail open={open}><DevisWorkflow devisId={42} stage="received">
        <WorkflowSection group="review" summary="Draft"><Draft /></WorkflowSection>
      </DevisWorkflow></VisitedDetail>;
    }
    const view = render(<Editor open={false} />);
    expect(screen.queryByLabelText("Editor draft")).not.toBeInTheDocument();
    view.rerender(<Editor open />);
    fireEvent.change(screen.getByLabelText("Editor draft"), { target: { value: "Unsaved quotation" } });
    fireEvent.click(screen.getByText("Save draft"));
    fireEvent.click(heading("Review source"));
    view.rerender(<Editor open={false} />);
    act(() => finish?.());
    expect(unmount).not.toHaveBeenCalled();
    view.rerender(<Editor open />);
    fireEvent.click(heading("Review source"));
    expect(screen.getByLabelText("Editor draft")).toHaveValue("Unsaved quotation");
    expect(screen.getByText("Unsaved quotation")).toBeVisible();
  });
  it("preserves visited translation tabs without mounting unvisited ones", () => {
    const content = (activeTab: string) => <Tabs value={activeTab}>
      <PreservedTabsContent activeTab={activeTab} value="lines"><input aria-label="French draft" /></PreservedTabsContent>
      <PreservedTabsContent activeTab={activeTab} value="translation"><input aria-label="English draft" /></PreservedTabsContent>
    </Tabs>;
    const view = render(content("lines"));
    expect(screen.queryByLabelText("English draft")).not.toBeInTheDocument();
    view.rerender(content("translation"));
    fireEvent.change(screen.getByLabelText("English draft"), { target: { value: "Reviewed English" } });
    view.rerender(content("lines"));
    expect(screen.getByLabelText("English draft")).not.toBeVisible();
    view.rerender(content("translation"));
    expect(screen.getByLabelText("English draft")).toHaveValue("Reviewed English");
  });
  it("reveals a collapsed outer row on a newly failed save, then respects manual recollapse", async () => {
    const reveal = vi.fn();
    const tree = (open: boolean, error: string) => <VisitedDetail open={open} onReveal={reveal}>
      {error && <p role="alert">{error}</p>}<input aria-label="Outer draft" defaultValue="Keep me" />
    </VisitedDetail>;
    const view = render(tree(true, ""));
    view.rerender(tree(false, ""));
    view.rerender(tree(false, "Pending save failed"));
    await waitFor(() => expect(reveal).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Pending save failed" })).toBeVisible();
    view.rerender(tree(true, "Pending save failed"));
    view.rerender(tree(false, "Pending save failed"));
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Outer draft")).toHaveValue("Keep me");
  });
});
