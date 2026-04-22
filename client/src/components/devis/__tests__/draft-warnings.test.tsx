// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { render, screen, within, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  CONTRACTOR_ADVISORY_FIELDS,
  CONTRACTOR_SELECT_TESTID,
  ContractorAdvisoryBanner,
  FOCUS_CONTRACTOR_SELECT_DELAY_MS,
  GenericValidationWarningsList,
  focusContractorSelect,
  partitionDraftWarnings,
  type DraftValidationWarning,
  type FocusableSection,
} from "../draft-warnings";

function makeWarning(
  field: string,
  overrides: Partial<DraftValidationWarning> = {},
): DraftValidationWarning {
  return {
    field,
    expected: null,
    actual: null,
    message: `warning for ${field}`,
    severity: "warning",
    ...overrides,
  };
}

describe("partitionDraftWarnings", () => {
  it("returns empty buckets for null/undefined/empty input", () => {
    for (const input of [null, undefined, []] as const) {
      const result = partitionDraftWarnings(input);
      expect(result.lotRefWarnings).toEqual([]);
      expect(result.contractorAdvisories).toEqual([]);
      expect(result.generic).toEqual([]);
    }
  });

  it("recognises every contractor advisory field listed in the task", () => {
    for (const field of [
      "contractor_identity_mismatch",
      "contractor_siret_collision",
      "unknown_contractor",
    ]) {
      expect(CONTRACTOR_ADVISORY_FIELDS.has(field)).toBe(true);
      const result = partitionDraftWarnings([makeWarning(field)]);
      expect(result.contractorAdvisories).toHaveLength(1);
      expect(result.contractorAdvisories[0].field).toBe(field);
      expect(result.generic).toHaveLength(0);
    }
  });

  it("never duplicates contractor or lotRef warnings into the generic list", () => {
    const warnings: DraftValidationWarning[] = [
      makeWarning("contractor_identity_mismatch"),
      makeWarning("contractor_siret_collision"),
      makeWarning("unknown_contractor"),
      makeWarning("contractorSiret"),
      makeWarning("contractorName"),
      makeWarning("lotReferences"),
      makeWarning("amountHt"),
      makeWarning("dateSent"),
    ];
    const { lotRefWarnings, contractorAdvisories, generic } =
      partitionDraftWarnings(warnings);
    expect(contractorAdvisories).toHaveLength(5);
    expect(lotRefWarnings).toHaveLength(1);
    expect(generic.map((w) => w.field).sort()).toEqual(
      ["amountHt", "dateSent"].sort(),
    );
    for (const w of generic) {
      expect(CONTRACTOR_ADVISORY_FIELDS.has(w.field)).toBe(false);
      expect(w.field).not.toBe("lotReferences");
    }
  });
});

describe("focusContractorSelect", () => {
  it("is a no-op when the section ref is null", () => {
    expect(() => focusContractorSelect(null)).not.toThrow();
  });

  it("scrolls into view and schedules a focus on the contractor select", () => {
    const focus = vi.fn();
    const querySelector = vi.fn().mockReturnValue({ focus });
    const scrollIntoView = vi.fn();
    const section: FocusableSection = { scrollIntoView, querySelector };
    let scheduled: { cb: () => void; delay: number } | null = null;
    focusContractorSelect(section, (cb, delay) => {
      scheduled = { cb, delay };
    });
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(querySelector).toHaveBeenCalledWith(
      `[data-testid="${CONTRACTOR_SELECT_TESTID}"]`,
    );
    expect(scheduled).not.toBeNull();
    expect(scheduled!.delay).toBe(FOCUS_CONTRACTOR_SELECT_DELAY_MS);
    scheduled!.cb();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a focus when the contractor select is missing", () => {
    const scrollIntoView = vi.fn();
    const querySelector = vi.fn().mockReturnValue(null);
    const schedule = vi.fn();
    focusContractorSelect(
      { scrollIntoView, querySelector } as FocusableSection,
      schedule,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe("ContractorAdvisoryBanner (rendered)", () => {
  const advisories: DraftValidationWarning[] = [
    makeWarning("contractor_identity_mismatch", {
      message: "Document name AT TRAVAUX does not match SIRET-matched contractor AT PISCINES.",
    }),
    makeWarning("contractor_siret_collision", {
      message: "Multiple contractors share SIRET 12345678900099.",
    }),
    makeWarning("unknown_contractor", {
      message: "SIRET 99999999900099 was found on the document but no contractor exists in ArchiTrak.",
    }),
  ];

  it("renders nothing when there are no advisories", () => {
    const { container } = render(
      <ContractorAdvisoryBanner
        warnings={[]}
        devisId={42}
        onChooseContractor={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("banner-contractor-advisory-42")).toBeNull();
  });

  it("renders the rose banner with one item per advisory", () => {
    render(
      <ContractorAdvisoryBanner
        warnings={advisories}
        devisId={42}
        onChooseContractor={() => {}}
      />,
    );
    const banner = screen.getByTestId("banner-contractor-advisory-42");
    expect(banner).toBeVisible();
    expect(banner.className).toMatch(/border-rose-400/);
    for (let i = 0; i < advisories.length; i++) {
      const item = within(banner).getByTestId(`contractor-advisory-42-${i}`);
      expect(item).toHaveTextContent(advisories[i].message);
    }
    expect(within(banner).getByTestId("button-choose-contractor-42")).toBeVisible();
  });

  it("hides the choose-contractor button when archived", () => {
    render(
      <ContractorAdvisoryBanner
        warnings={advisories}
        devisId={7}
        isArchived
        onChooseContractor={() => {}}
      />,
    );
    expect(screen.queryByTestId("button-choose-contractor-7")).toBeNull();
  });

  it("invokes onChooseContractor when the button is clicked", () => {
    const onChoose = vi.fn();
    render(
      <ContractorAdvisoryBanner
        warnings={advisories}
        devisId={11}
        onChooseContractor={onChoose}
      />,
    );
    fireEvent.click(screen.getByTestId("button-choose-contractor-11"));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });
});

/**
 * Mini render harness that mirrors the way DraftReviewPanel composes
 * ContractorAdvisoryBanner + GenericValidationWarningsList around
 * partitionDraftWarnings + focusContractorSelect. Lets us assert the
 * end-to-end behaviour of the dialog body's two warning sections without
 * standing up the full dialog (Radix Dialog, react-query, AdvisoriesList,
 * ContractorSelect, etc.).
 */
function DraftReviewWarningsHarness({
  warnings,
  devisId,
}: {
  warnings: DraftValidationWarning[];
  devisId: number;
}) {
  const { contractorAdvisories, generic } = partitionDraftWarnings(warnings);
  const sectionRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <ContractorAdvisoryBanner
        warnings={contractorAdvisories}
        devisId={devisId}
        onChooseContractor={() => focusContractorSelect(sectionRef.current)}
      />
      <GenericValidationWarningsList warnings={generic} />
      <div ref={sectionRef}>
        <button
          type="button"
          data-testid={CONTRACTOR_SELECT_TESTID}
          onClick={() => {}}
        >
          Pick contractor
        </button>
      </div>
    </div>
  );
}

describe("Draft review warnings end-to-end (banner + list integration)", () => {
  const warnings: DraftValidationWarning[] = [
    makeWarning("contractor_identity_mismatch", {
      message: "Document name AT TRAVAUX does not match SIRET-matched contractor AT PISCINES.",
    }),
    makeWarning("contractor_siret_collision", {
      message: "Multiple contractors share SIRET 12345678900099.",
    }),
    makeWarning("unknown_contractor", {
      message: "SIRET 99999999900099 was found on the document but no contractor exists in ArchiTrak.",
    }),
    makeWarning("amountHt", {
      message: "Sample generic warning that should still appear in the warnings section.",
    }),
  ];
  const devisId = 555;

  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom does not implement scrollIntoView; stub it so the focus action runs.
    if (!(Element.prototype as any).scrollIntoView) {
      (Element.prototype as any).scrollIntoView = function () {};
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the rose banner and the generic warnings list without duplicating advisories", () => {
    render(<DraftReviewWarningsHarness warnings={warnings} devisId={devisId} />);

    // Banner is visible with all three contractor advisories.
    const banner = screen.getByTestId(`banner-contractor-advisory-${devisId}`);
    expect(banner).toBeVisible();
    expect(within(banner).getAllByTestId(/^contractor-advisory-/)).toHaveLength(3);

    // Generic warnings section is visible and contains ONLY the generic entry.
    const section = screen.getByTestId("section-validation-warnings");
    expect(section).toBeVisible();
    expect(within(section).getByTestId("warning-amountHt-0")).toHaveTextContent(
      "Sample generic warning",
    );

    // Dedup contract: none of the advisory messages leak into the generic list.
    for (const advisory of warnings.slice(0, 3)) {
      expect(section).not.toHaveTextContent(advisory.message);
      expect(within(section).queryByTestId(`warning-${advisory.field}-0`)).toBeNull();
    }
  });

  it("moves keyboard focus to the contractor select when 'Choose contractor' is clicked", () => {
    render(<DraftReviewWarningsHarness warnings={warnings} devisId={devisId} />);

    const select = screen.getByTestId(CONTRACTOR_SELECT_TESTID);
    expect(document.activeElement).not.toBe(select);

    fireEvent.click(screen.getByTestId(`button-choose-contractor-${devisId}`));

    // The focus is scheduled inside a 250 ms timeout — advance the timers.
    vi.advanceTimersByTime(FOCUS_CONTRACTOR_SELECT_DELAY_MS + 1);

    expect(document.activeElement).toBe(select);
  });
});
