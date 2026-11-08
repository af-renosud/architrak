import { describe, expect, it, vi, beforeEach } from "vitest";
vi.mock("../gemini", () => ({ generateWithGemini: vi.fn() }));
import { generateWithGemini } from "../gemini";
import { explainQuotationAction, actionFingerprint } from "../quotation-next-action-explanation";
import type { QuotationNextAction } from "@shared/quotation-next-actions";
const action: QuotationNextAction = { id: "1:certificate:10", code: "verify_payment", label: "Verify payment evidence",
  why: "There is an unreviewed reply.", nextStep: "Open the certificate and review the evidence.",
  actor: "architect", tone: "action", priority: 10, devisId: 1, certificateId: 10, certificateRef: "C1",
  outstandingTtc: "123.45", href: "/certificats?projectId=9&certificatId=10" };
beforeEach(() => vi.resetAllMocks());
describe("bounded AI explanations", () => {
  it("renders only approved factual sentences, never arbitrary model text or links", async () => {
    vi.mocked(generateWithGemini).mockResolvedValue({ text: '{"ids":["safety","evidence"],"invented":"Pay now"}', modelId: "test" });
    const result = await explainQuotationAction(action);
    expect(result.source).toBe("ai");
    expect(result.explanation).toContain("not proof of payment");
    expect(result.explanation).not.toContain("Pay now");
    const sent = vi.mocked(generateWithGemini).mock.calls[0][0].userContent;
    expect(sent).not.toContain("123.45");
    expect(sent).not.toContain("/certificats");
  });
  it.each(['{"ids":["pay_immediately"]}', "Pay €999 now", '{"ids":["__proto__"]}'])("rejects invented instructions: %s", async text => {
    vi.mocked(generateWithGemini).mockResolvedValue({ text, modelId: "test" });
    expect(await explainQuotationAction(action)).toMatchObject({ source: "fallback", explanation: `${action.why} ${action.nextStep}` });
  });
  it("fails explicitly to factual fallback without provider error leakage", async () => {
    vi.mocked(generateWithGemini).mockRejectedValue(new Error("sensitive error"));
    const result = await explainQuotationAction(action);
    expect(result.source).toBe("fallback");
    expect(result.explanation).not.toContain("sensitive");
  });
  it("changes the fingerprint when the outstanding balance changes", () => {
    expect(actionFingerprint(action)).not.toBe(actionFingerprint({ ...action, outstandingTtc: "23.45" }));
  });
});
