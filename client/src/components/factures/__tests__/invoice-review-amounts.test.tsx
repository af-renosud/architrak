// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { InvoiceAmountCalculationHint, InvoiceDepositContext } from "../InvoiceDepositContext";
import { parseReviewAmount, readDepositDocument, useInvoiceReviewAmounts } from "../invoice-review-amounts";
import type { DepositDocument } from "@shared/invoice-deposit";

afterEach(cleanup);

const evidence: DepositDocument = {
  documentType: "invoice",
  amountHt: 18237.45,
  amountTtc: 20061.2,
  tvaRate: 10,
  netAPayer: 6018.36,
  rawText: "FACTURE D'ACOMPTE DE 30% DU TOTAL TTC\nTVA 10%",
};

function Review({ ht = "18237.45", ttc = "20061.20", data = evidence, disabled = false }: {
  ht?: string;
  ttc?: string;
  data?: DepositDocument;
  disabled?: boolean;
}) {
  const review = useInvoiceReviewAmounts(data, ht, ttc);
  return (
    <>
      <InvoiceDepositContext review={review} invoiceId={17} disabled={disabled} />
      <input aria-label="HT" value={review.amountHt} onChange={e => review.editAmount(e.target.value, "ht")} />
      <input aria-label="TTC" value={review.amountTtc} onChange={e => review.editAmount(e.target.value, "ttc")} />
      <InvoiceAmountCalculationHint review={review} invoiceId={17} />
    </>
  );
}

describe("invoice draft deposit context", () => {
  it("preserves old full-contract amounts until the operator applies both deposit amounts", () => {
    render(<Review />);
    expect(screen.getByLabelText("HT")).toHaveValue("18237.45");
    expect(screen.getByLabelText("TTC")).toHaveValue("20061.20");
    expect(screen.getByText(/not a deposit already paid/)).toBeInTheDocument();
    expect(screen.getByText(/Older drafts may contain/)).toBeInTheDocument();
    expect(screen.getByText(/30% of the full contract TTC/)).toBeInTheDocument();
    expect(screen.getByText(/Deposit HT =/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply requested deposit amounts" }));
    expect(screen.getByLabelText("HT")).toHaveValue("5471.24");
    expect(screen.getByLabelText("TTC")).toHaveValue("6018.36");
    expect(screen.getByTestId("text-deposit-populated-17")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply requested deposit amounts" })).not.toBeInTheDocument();
    expect(screen.getByText(/HT was derived from TTC/)).toBeInTheDocument();
  });

  it("recognizes new persisted deposit values without changing them or the contract reference", () => {
    render(<Review ht="5471.24" ttc="6018.36" />);
    expect(screen.getByTestId("text-deposit-populated-17")).toBeInTheDocument();
    expect(screen.getByText("Full contract reference — not this claim")).toBeInTheDocument();
    expect(screen.getByLabelText("HT")).toHaveValue("5471.24");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not offer an enabled apply action in protected state", () => {
    render(<Review disabled />);
    expect(screen.getByRole("button", { name: "Apply requested deposit amounts" })).toBeDisabled();
  });

  it("warns when printed percentage and net payable do not reconcile", () => {
    render(<Review data={{ ...evidence, netAPayer: 7018.36 }} />);
    expect(screen.getByTestId("warning-unresolved-deposit-17")).toHaveTextContent("No deposit amounts have been applied");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByLabelText("HT")).toHaveValue("18237.45");
  });

  it("shows multiple declared rates with a manual-review explanation", () => {
    render(<Review data={{ ...evidence, declaredTvaRates: [10, 20] }} />);
    expect(screen.getByTestId("text-draft-invoice-tva-derived-17")).toHaveTextContent("10%, 20%");
    expect(screen.getByTestId("text-draft-invoice-tva-derived-17")).toHaveTextContent("No default or blended rate");
    expect(screen.getByTestId("warning-unresolved-deposit-17")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("HT"), { target: { value: "750" } });
    expect(screen.getByLabelText("TTC")).toHaveValue("20061.20");
  });
});

describe("invoice amount editing", () => {
  it("uses original parsed evidence and recalculates in both directions", () => {
    const { result } = renderHook(() => useInvoiceReviewAmounts(evidence, "1", "2"));
    expect(result.current.amountHt).toBe("1");
    expect(result.current.amountTtc).toBe("2");
    act(() => result.current.editAmount("873.57", "ht"));
    expect(result.current.amountTtc).toBe("960.93");
    expect(result.current.derivedField).toBe("ttc");
    act(() => result.current.editAmount("960.93", "ttc"));
    expect(result.current.amountHt).toBe("873.57");
    expect(result.current.derivedField).toBe("ht");
  });

  it("does not reset user edits when evidence is refetched", () => {
    const { result, rerender } = renderHook(({ data }) => useInvoiceReviewAmounts(data, "18237.45", "20061.20"), { initialProps: { data: evidence } });
    act(() => result.current.editAmount("750", "ht"));
    rerender({ data: { ...evidence } });
    expect(result.current.amountHt).toBe("750");
    expect(result.current.amountTtc).toBe("825.00");
    expect(result.current.matchesDeposit).toBe(false);
  });

  it.each(["", " ", "oops", "-", "-1", "10abc", "Infinity", "1."])("does not turn invalid input %j into zero or recalculate its counterpart", value => {
    const { result } = renderHook(() => useInvoiceReviewAmounts(evidence, "18237.45", "20061.20"));
    act(() => result.current.editAmount(value, "ht"));
    expect(result.current.amountHt).toBe(value);
    expect(result.current.amountTtc).toBe("20061.20");
    expect(result.current.validAmounts).toBe(false);
    expect(result.current.tvaAmount).toBeNull();
    expect(result.current.derivedField).toBeNull();
  });

  it("accepts explicit zero without mistaking blank input for it", () => {
    expect(parseReviewAmount("")).toBeNull();
    expect(parseReviewAmount("0")).toBe(0);
    const { result } = renderHook(() => useInvoiceReviewAmounts(evidence, "1", "2"));
    act(() => result.current.editAmount("0", "ttc"));
    expect(result.current.amountHt).toBe("0.00");
    expect(result.current.validAmounts).toBe(true);
  });

  it.each([
    { documentType: "invoice", amountHt: 100, amountTtc: 120 },
    { ...evidence, declaredTvaRates: [20] },
    { ...evidence, amountTtc: 21884.94 },
    { ...evidence, autoLiquidation: true },
    { ...evidence, preTaxChargesHt: 87.50 },
  ])("does not guess a rate when evidence is missing, multiple or inconsistent: %j", data => {
    const { result } = renderHook(() => useInvoiceReviewAmounts(data, "100", "120"));
    expect(result.current.rate).toBeNull();
    act(() => result.current.editAmount("200", "ttc"));
    expect(result.current.amountHt).toBe("100");
    expect(result.current.amountTtc).toBe("200");
    expect(result.current.derivedField).toBeNull();
  });

  it("uses original source totals if parsed evidence already contains deposit amounts", () => {
    const data = {
      ...evidence,
      amountHt: 5471.24,
      amountTtc: 6018.36,
      openingDepositSourceTotals: { amountHt: 18237.45, amountTtc: 20061.2 },
    };
    const { result } = renderHook(() => useInvoiceReviewAmounts(data, "5471.24", "6018.36"));
    expect(result.current.deposit?.sourceTtc).toBe(20061.2);
    expect(result.current.matchesDeposit).toBe(true);
  });

  it("allows a verified zero tax rate", () => {
    const { result } = renderHook(() => useInvoiceReviewAmounts({ amountHt: 87.5, amountTtc: 87.5, tvaRate: 0 }, "87.50", "87.50"));
    act(() => result.current.editAmount("123.45", "ht"));
    expect(result.current.rate).toBe(0);
    expect(result.current.amountTtc).toBe("123.45");
  });

  it.each([null, [], "not a document", { ...evidence, declaredTvaRates: "10" }, { ...evidence, openingDepositSourceTotals: "bad" }, { ...evidence, amountHt: "18237.45" }])("handles malformed evidence safely: %j", data => {
    expect(() => readDepositDocument(data)).not.toThrow();
    const { result } = renderHook(() => useInvoiceReviewAmounts(data, "100", "120"));
    expect(result.current.rate).toBeNull();
    expect(result.current.deposit).toBeNull();
  });
});
