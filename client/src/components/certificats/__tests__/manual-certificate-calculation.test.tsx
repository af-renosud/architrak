// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import {
  AutomaticTvaFields,
  type ManualCertificatPreview,
} from "../AutomaticTvaFields";
import {
  ManualCertificateTotals,
  RetentionReview,
} from "../ManualCertificateTotals";

function preview(
  retention: ManualCertificatPreview["explanation"]["retention"] = {
    source: "marche",
    ratePercent: "5",
    rateSource: "marche",
    baseHt: "4600",
  },
): ManualCertificatPreview {
  return {
    works: {
      enteredAmount: "4600",
      enteredBasis: "ht",
      amountHt: "4600",
      amountTtc: "5520",
    },
    deductions: {
      retenueGarantie: "230",
      cumulativeProrataDeduction: "50",
      periodProrataDeduction: "50",
      cumulativeAcompteRecoupment: "100",
      periodAcompteRecoupment: "100",
      retenueReleaseAmount: "20",
      netToPayHt: "4370",
      tvaAmount: "874",
      netToPayTtc: "5244",
      tvaRatePercent: "20",
      tvaAutoliquidation: false,
      tvaRateSource: "devis",
    },
    tva: {
      ratePercent: "20",
      autoliquidation: false,
      source: "devis",
      evidenceKind: "signed_quotation",
    },
    explanation: {
      grossCumulativeHt: "4700",
      pvMvAdjustment: "100",
      previousPayments: "70",
      retention,
    },
  };
}

describe("AutomaticTvaFields", () => {
  it("distinguishes gross TVA from the net payable TVA", () => {
    render(
      <AutomaticTvaFields
        enteredAmount="4600"
        basis="ht"
        preview={preview()}
        isLoading={false}
        onEdit={vi.fn()}
        testIdPrefix="amount"
      />,
    );

    expect(screen.getByText("TVA on gross works")).toBeInTheDocument();
    expect(screen.getByTestId("amount-decision")).toHaveTextContent(/920,00/);
    expect(screen.getByTestId("amount-decision")).not.toHaveTextContent(/874,00/);
    expect(screen.getByText("Gross Works HT (Cumulative)")).toBeInTheDocument();
    expect(screen.getByText("Gross Works TTC (Cumulative)")).toBeInTheDocument();
  });

  it("labels autoliquidation explicitly", () => {
    const value = preview();
    value.tva = {
      ...value.tva,
      ratePercent: "0",
      autoliquidation: true,
      evidenceKind: "autoliquidation",
    };
    render(
      <AutomaticTvaFields
        enteredAmount="4600"
        basis="ht"
        preview={value}
        isLoading={false}
        onEdit={vi.fn()}
        testIdPrefix="auto"
      />,
    );
    expect(screen.getByTestId("auto-rate")).toHaveTextContent("0% — Autoliquidation");
    expect(screen.getByTestId("auto-source")).toHaveTextContent("Autoliquidation");
  });

  it.each([
    { basis: "ht" as const, enteredAmount: "4600", entered: "ht", counterpart: "ttc" },
    { basis: "ttc" as const, enteredAmount: "5520", entered: "ttc", counterpart: "ht" },
  ])(
    "preserves the entered $basis value but blanks retained conversion during refetch",
    ({ basis, enteredAmount, entered, counterpart }) => {
      render(
        <AutomaticTvaFields
          enteredAmount={enteredAmount}
          basis={basis}
          preview={preview()}
          isLoading
          onEdit={vi.fn()}
          testIdPrefix="refetch"
        />,
      );

      expect(screen.getByTestId(`refetch-${entered}`)).toHaveValue(Number(enteredAmount));
      expect(screen.getByTestId(`refetch-${entered}`)).not.toBeDisabled();
      expect(screen.getByTestId(`refetch-${counterpart}`)).toHaveValue(null);
      expect(screen.getByTestId(`refetch-${counterpart}`)).toBeDisabled();
      expect(screen.getByTestId("refetch-decision")).not.toHaveTextContent("920,00");
    },
  );

  it.each([
    { basis: "ht" as const, enteredAmount: "4600", entered: "ht", counterpart: "ttc" },
    { basis: "ttc" as const, enteredAmount: "5520", entered: "ttc", counterpart: "ht" },
  ])(
    "preserves the entered $basis value but blanks retained conversion after refetch error",
    ({ basis, enteredAmount, entered, counterpart }) => {
      render(
        <AutomaticTvaFields
          enteredAmount={enteredAmount}
          basis={basis}
          preview={preview()}
          isLoading={false}
          error={new Error("preview failed")}
          onEdit={vi.fn()}
          testIdPrefix="error"
        />,
      );

      expect(screen.getByTestId(`error-${entered}`)).toHaveValue(Number(enteredAmount));
      expect(screen.getByTestId(`error-${counterpart}`)).toHaveValue(null);
      expect(screen.getByTestId("error-decision")).toHaveTextContent("preview failed");
      expect(screen.getByTestId("error-decision")).not.toHaveTextContent("920,00");
    },
  );

  it.each([
    ["marche", "Configuration fiscale du marché"],
    ["contractor", "Configuration fiscale de l’entreprise"],
  ])(
    "uses authoritative %s source instead of signed-quotation evidence wording",
    (source, expectedLabel) => {
      const value = preview();
      value.tva.source = source;
      value.tva.evidenceKind = "signed_quotation";
      render(
        <AutomaticTvaFields
          enteredAmount="4600"
          basis="ht"
          preview={value}
          isLoading={false}
          onEdit={vi.fn()}
          testIdPrefix={`source-${source}`}
        />,
      );

      expect(screen.getByTestId(`source-${source}-source`)).toHaveTextContent(expectedLabel);
      expect(screen.getByTestId(`source-${source}-source`)).not.toHaveTextContent("montants HT/TTC extraits");
    },
  );
});

describe("ManualCertificateTotals", () => {
  it("shows the gross-to-net waterfall with signed deductions and net TVA", () => {
    render(<ManualCertificateTotals preview={preview()} isLoading={false} />);

    const totals = screen.getByTestId("manual-certificate-totals");
    expect(totals).toHaveTextContent("Gross works (cumulative)");
    expect(totals).toHaveTextContent("PV/MV adjustment (+ / −)");
    expect(totals).toHaveTextContent("Less retention (cumulative)");
    expect(totals).toHaveTextContent("Less Compte Prorata (cumulative)");
    expect(totals).toHaveTextContent("Less previous net certified (cumulative)");
    expect(totals).toHaveTextContent("Less deposit recoupment (this period)");
    expect(totals).toHaveTextContent("Add retention release (this period)");
    expect(totals).toHaveTextContent("-230,00");
    expect(totals).toHaveTextContent("-50,00");
    expect(totals).toHaveTextContent("-70,00");
    expect(totals).toHaveTextContent("-100,00");
    expect(totals).toHaveTextContent(/874,00.*TVA/);
    expect(totals).not.toHaveTextContent(/920,00/);
  });

  it("hides stale monetary totals while loading or errored", () => {
    const { rerender } = render(
      <ManualCertificateTotals preview={preview()} isLoading />,
    );
    expect(screen.queryByTestId("manual-certificate-totals")).not.toBeInTheDocument();
    expect(screen.queryByText(/4[\s\u00a0\u202f]600,00/)).not.toBeInTheDocument();

    rerender(
      <ManualCertificateTotals
        preview={preview()}
        isLoading={false}
        error={new Error("preview failed")}
      />,
    );
    expect(screen.queryByTestId("manual-certificate-totals")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Calculation unavailable");
  });

  it("marks autoliquidation on payable TVA", () => {
    const value = preview();
    value.tva.autoliquidation = true;
    render(<ManualCertificateTotals preview={value} isLoading={false} />);
    expect(screen.getByText(/TVA on net payable HT.*Autoliquidation/)).toBeInTheDocument();
  });
});

describe("RetentionReview", () => {
  it.each([
    [
      { source: "marche", ratePercent: "5", rateSource: "marche", baseHt: "4600" },
      "Marché configuration",
    ],
    [
      { source: "default", ratePercent: "5", rateSource: "default", baseHt: "4600" },
      "Application default",
    ],
    [
      { source: "override", ratePercent: "5", rateSource: "marche", baseHt: "4600" },
      "Operator override",
    ],
    [
      { source: "bank_guarantee", ratePercent: "5", rateSource: "marche", baseHt: "4600" },
      "Bank guarantee",
    ],
  ] as const)("explains the configured/default/override/guarantee source", (retention, label) => {
    render(
      <RetentionReview
        preview={preview(retention)}
        isLoading={false}
        value=""
        onChange={vi.fn()}
        inputId="retention"
      />,
    );
    expect(screen.getByTestId("retention-source")).toHaveTextContent(label);
  });

  it("offers non-submitting zero, automatic, and custom override actions", () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const onChange = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <RetentionReview
          preview={preview()}
          isLoading={false}
          value=""
          onChange={onChange}
          inputId="input-cert-retenue-override"
        />
      </form>,
    );

    fireEvent.click(screen.getByTestId("button-no-retention"));
    fireEvent.click(screen.getByTestId("button-auto-retention"));
    fireEvent.change(screen.getByTestId("input-cert-retenue-override"), {
      target: { value: "125" },
    });

    expect(onChange).toHaveBeenNthCalledWith(1, "0.00");
    expect(onChange).toHaveBeenNthCalledWith(2, "");
    expect(onChange).toHaveBeenNthCalledWith(3, "125");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("retention-review")).getByText(/Custom cumulative retention override/)).toBeInTheDocument();
  });
});