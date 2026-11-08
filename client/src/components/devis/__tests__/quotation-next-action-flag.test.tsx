// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuotationNextActionFlag } from "../QuotationNextActionFlag";
import { QuotationNextActionsSummary } from "../QuotationNextActionsSummary";
import { goToQuotationTarget } from "../action-requirements";
import type { QuotationNextActionsController } from "@/hooks/use-quotation-next-actions";
import type { NextActionExplanation, ProjectNextActions, QuotationNextAction } from "@shared/quotation-next-actions";
import { currentNextAction, isNextActionDependency, matchesNextActionFilter, nextActionEligible, nextActionHref, nextActionsFresh } from "@/lib/quotation-next-actions";

const action: QuotationNextAction = {
  id: "pay-17-42", code: "payment", label: "Review outstanding certificate", why: "Payment remains unverified.",
  nextStep: "Open the certificate and check the evidence.", actor: "architect", tone: "blocked", priority: 1,
  devisId: 17, certificateId: 42, certificateRef: "C-0042 / 2026", outstandingTtc: "1837.42", href: "/certificats",
};
const data = (): ProjectNextActions => ({ projectId: 4, generatedAt: new Date().toISOString(),
  quotations: { 17: { devisId: 17, actionable: true, actions: [action] } }, actionableCount: 1 });
function controller(overrides: Partial<QuotationNextActionsController> = {}): QuotationNextActionsController {
  return {
    data: data(), unknown: false, loading: false, fetching: false, error: false,
    retry: vi.fn(), revalidate: vi.fn(async () => action),
    explain: vi.fn(async () => ({ actionId: action.id, source: "fallback", explanation: "Verify the recorded payment." })),
    ...overrides,
  } as QuotationNextActionsController;
}
afterEach(cleanup);

describe("safe quotation next-action guidance", () => {
  it("filters only actionable eligible rows, intersects with other filters, and fails closed when unknown", () => {
    const rows = [{ id: 17, status: "signed", accountingState: "active", lot: "A" }, { id: 18, status: "pending", lot: "B" }];
    expect(rows.filter(row => row.lot === "B" && matchesNextActionFilter(row, false, true, data(), false))).toEqual([]);
    expect(rows.filter(row => matchesNextActionFilter(row, false, true, data(), false)).map(row => row.id)).toEqual([17]);
    expect(matchesNextActionFilter(rows[0], false, true, data(), true)).toBe(false);
    expect(matchesNextActionFilter(rows[0], false, false, undefined, true)).toBe(true);
    expect(nextActionEligible({ status: "void" }, false)).toBe(false);
    expect(nextActionEligible({ status: "cancelled" }, false)).toBe(false);
    expect(nextActionEligible({ status: "superseded" }, false)).toBe(false);
    expect(nextActionEligible({ status: "signed", signOffStage: "void" }, false)).toBe(false);
    expect(nextActionEligible({ status: "pending", accountingState: "superseded" }, false)).toBe(false);
    expect(nextActionEligible(rows[0], true)).toBe(false);
    for (const row of [
      { id: 17, status: "cancelled" },
      { id: 17, status: "superseded" },
      { id: 17, status: "signed", signOffStage: "void" },
    ]) expect(matchesNextActionFilter(row, false, true, data(), false)).toBe(false);
  });

  it("hides verified empty flags, but keeps unknown empty responses visible", () => {
    const guidance = controller({ data: { ...data(), quotations: { 17: { devisId: 17, actionable: false, actions: [] } } } });
    const { rerender } = render(<QuotationNextActionFlag devisId={17} projectId="4" controller={guidance} onExpand={vi.fn()} />);
    expect(screen.queryByTestId("next-action-17")).not.toBeInTheDocument();
    rerender(<QuotationNextActionFlag devisId={17} projectId="4" controller={{ ...guidance, unknown: true }} onExpand={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Next action unknown" })).toBeInTheDocument();
  });

  it("shows unknown-evidence quotation count beside zero actionable, without making unknown evidence actionable", () => {
    const unknown: QuotationNextAction = { ...action, id: "unknown-17", tone: "unknown", actor: "system" };
    const guidance = controller({ data: { ...data(), actionableCount: 0, quotations: {
      17: { devisId: 17, actionable: false, actions: [unknown, { ...unknown, id: "another-unknown-17" }] },
      18: { devisId: 18, actionable: true, actions: [{ ...unknown, devisId: 18 }] },
      19: { devisId: 19, actionable: true, actions: [{ ...unknown, devisId: 19 }] },
    } } });
    const toggle = vi.fn();
    render(<QuotationNextActionsSummary rows={[
      { id: 17, status: "pending" }, { id: 18, status: "cancelled" }, { id: 19, status: "signed", signOffStage: "void" },
    ]} controller={guidance} selected={false} onToggle={toggle} />);
    expect(screen.getByRole("button", { name: "Action needed (0)" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("1 quotation with unknown evidence — review required.");
    fireEvent.click(screen.getByRole("button", { name: "Action needed (0)" }));
    expect(toggle).toHaveBeenCalledOnce();
    expect(matchesNextActionFilter({ id: 17, status: "pending" }, false, true, guidance.data, false)).toBe(false);
  });

  it("rejects stale/changed facts and builds an exact certificate link", () => {
    expect(nextActionsFresh({ ...data(), generatedAt: "invalid" })).toBe(false);
    expect(nextActionsFresh({ ...data(), generatedAt: new Date(Date.now() - 66_000).toISOString() })).toBe(false);
    expect(() => currentNextAction(data(), { ...action, outstandingTtc: "0" })).toThrow("changed");
    expect(nextActionHref(action, "4")).toBe("/certificats?projectId=4&certificatId=42");
    expect(nextActionHref({ ...action, certificateId: undefined, href: "//untrusted.example" }, "4")).toBeUndefined();
    expect(isNextActionDependency(["/api/devis", 17, "translation"], "4")).toBe(true);
    expect(isNextActionDependency(["/api/projects", "4", "quotation-next-actions"], "4")).toBe(false);
  });

  it("labels the verified blocker, exact reference, TTC and factual explanation without financial side effects", async () => {
    const guidance = controller();
    const expand = vi.fn();
    render(<QuotationNextActionFlag devisId={17} projectId="4" controller={guidance} onExpand={expand} />);
    fireEvent.click(screen.getByRole("button", { name: /Verified blocker/ }));
    expect(screen.getByText("C-0042 / 2026")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View certificate" })).toHaveAttribute("href", "/certificats?projectId=4&certificatId=42");
    expect(screen.getByText("TTC")).toBeInTheDocument();
    expect(screen.getByText("Why:")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Explain this action" }));
    expect(await screen.findByText("Factual fallback")).toBeInTheDocument();
    expect(guidance.explain).toHaveBeenCalledWith(action);
    expect(expand).not.toHaveBeenCalled();
  });

  it("shows unknown and retry rather than a stale blocker or all-clear", async () => {
    const guidance = controller({ unknown: true });
    render(<QuotationNextActionFlag devisId={17} projectId="4" controller={guidance} onExpand={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Next action unknown" }));
    expect(screen.queryByText("Review outstanding certificate")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Explain this action" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry guidance" }));
    expect(guidance.retry).toHaveBeenCalledOnce();
  });

  it("renders AI text literally and removes the explanation when guidance becomes unknown", async () => {
    let finish!: (value: NextActionExplanation) => void;
    const guidance = controller({ explain: vi.fn(() => new Promise<NextActionExplanation>(resolve => { finish = resolve; })) });
    const { rerender } = render(<QuotationNextActionFlag devisId={17} projectId="4" controller={guidance} onExpand={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Verified blocker/ }));
    fireEvent.click(screen.getByRole("button", { name: "Explain this action" }));
    await act(async () => { finish({ actionId: action.id, source: "ai", explanation: "<b>Not authorization</b>" }); });
    expect(await screen.findByText("AI explanation")).toBeInTheDocument();
    expect(screen.getByText("<b>Not authorization</b>").tagName).toBe("P");
    rerender(<QuotationNextActionFlag devisId={17} projectId="4" controller={{ ...guidance, unknown: true }} onExpand={vi.fn()} />);
    expect(screen.queryByText("<b>Not authorization</b>")).not.toBeInTheDocument();
  });

  it("discards an explanation that finishes after guidance became unknown", async () => {
    let finish!: (value: NextActionExplanation) => void;
    const guidance = controller({ explain: vi.fn(() => new Promise<NextActionExplanation>(resolve => { finish = resolve; })) });
    const { rerender } = render(<QuotationNextActionFlag devisId={17} projectId="4" controller={guidance} onExpand={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Verified blocker/ }));
    fireEvent.click(screen.getByRole("button", { name: "Explain this action" }));
    rerender(<QuotationNextActionFlag devisId={17} projectId="4" controller={{ ...guidance, unknown: true }} onExpand={vi.fn()} />);
    await act(async () => { finish({ actionId: action.id, source: "ai", explanation: "Outdated advice" }); });
    expect(screen.queryByText("Outdated advice")).not.toBeInTheDocument();
    expect(screen.queryByText("AI explanation")).not.toBeInTheDocument();
  });

  it("closes the popover and expands before focusing the header deposit control without restoring trigger focus or opening workflow sections", async () => {
    const deposit: QuotationNextAction = { ...action, id: "deposit-17", tone: "action", label: "Review deposit",
      certificateId: undefined, certificateRef: undefined, outstandingTtc: undefined, target: "deposit" };
    const waiting: QuotationNextAction = { ...deposit, id: "waiting-17", tone: "waiting", label: "Await contractor response", actor: "contractor", target: undefined, href: "" };
    const guidance = controller({ data: { ...data(), quotations: { 17: { devisId: 17, actions: [deposit, waiting], actionable: true } } },
      revalidate: vi.fn(async () => deposit) });
    const order: string[] = [];
    const target = vi.fn();
    const clicked = vi.fn();
    window.addEventListener("architrak:workflow-target", target);
    render(<div data-testid="card-devis-17">
      <QuotationNextActionFlag devisId={17} projectId="4" controller={guidance} onExpand={() => order.push("expand")} />
      <button type="button" data-testid="button-acompte-generate-cert-17" onFocus={() => order.push("focus")} onClick={clicked}>Generate Certificate</button>
      <div data-testid="workflow-root-17" />
    </div>);
    fireEvent.click(screen.getByRole("button", { name: "Action needed: Review deposit" }));
    expect(screen.getByText("Await contractor response")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to next step" }));
    await waitFor(() => expect(order).toEqual(["expand", "focus"]));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
    expect(screen.getByTestId("button-acompte-generate-cert-17")).toHaveFocus();
    expect(screen.queryByText("Quotation next actions")).not.toBeInTheDocument();
    expect(clicked).not.toHaveBeenCalled();
    expect(target).not.toHaveBeenCalled();
    expect(guidance.revalidate).toHaveBeenCalledWith(deposit);
    window.removeEventListener("architrak:workflow-target", target);
  });

  it("refuses navigation when revalidation fails and only reveals the deposit control, never clicks it", async () => {
    const guidance = controller({ revalidate: vi.fn(async () => { throw new Error("Guidance changed"); }) });
    const expand = vi.fn();
    render(<QuotationNextActionFlag devisId={17} projectId="4" controller={guidance} onExpand={expand} />);
    fireEvent.click(screen.getByRole("button", { name: /Verified blocker/ }));
    fireEvent.click(screen.getByRole("link", { name: "View certificate" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Guidance changed"));
    expect(expand).not.toHaveBeenCalled();
    const target = vi.fn();
    const clicked = vi.fn();
    window.addEventListener("architrak:workflow-target", target);
    const button = document.createElement("button");
    button.dataset.testid = "button-acompte-generate-cert-17";
    button.onclick = clicked;
    document.body.appendChild(button);
    goToQuotationTarget(17, "deposit", "4");
    expect(button).toHaveFocus();
    expect(target).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
    button.remove();
    window.removeEventListener("architrak:workflow-target", target);
  });
});
