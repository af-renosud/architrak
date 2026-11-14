// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QuotationVersionGroup } from "../QuotationVersionGroup";
import { filterQuotationVersionGroups, groupQuotationVersions } from "../quotation-version-groups";
import { useQuotationOpeningScroll } from "@/hooks/use-quotation-opening-scroll";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const rows = [
  { id: 17, status: "signed", accountingState: "superseded", ref: "ORIGINAL-17" },
  { id: 24, status: "superseded", accountingState: "superseded", ref: "REVISION-24" },
  { id: 38, status: "draft", accountingState: "active", ref: "CURRENT-38" },
];
const history = [{ oldDevisId: 17, newDevisId: 24 }, { oldDevisId: 24, newDevisId: 38 }];

function HistoricalEditor({ id }: { id: number }) {
  const [draft, setDraft] = useState("");
  return <input aria-label={`Historical draft ${id}`} value={draft} onChange={event => setDraft(event.target.value)} />;
}

/** Uses the same family selector and full-row render contract as DevisTab. */
function List({ directLinkId = null, historyAvailable = true }: {
  directLinkId?: number | null; historyAvailable?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<number | null>(directLinkId);
  const matches = (row: typeof rows[number]) => row.ref.includes(search);
  const groups = filterQuotationVersionGroups(
    groupQuotationVersions(rows, history, { historyAvailable }), matches, directLinkId,
  );
  useQuotationOpeningScroll("project-4", directLinkId, historyAvailable && expanded === directLinkId, null);
  return (
    <>
      <input aria-label="Search quotations" value={search} onChange={e => setSearch(e.target.value)} />
      {groups.map(group => (
        <QuotationVersionGroup
          key={group.current.id}
          group={group}
          revealKey={group.previous.some(row => row.id === directLinkId || (!!search && matches(row)))
            ? JSON.stringify([search, directLinkId]) : ""}
          renderRow={(row, historical) => (
            <article data-testid={`row-${row.id}`}>
              <button onClick={() => setExpanded(expanded === row.id ? null : row.id)}>{row.ref}</button>
              {!historical && <input type="checkbox" aria-label={`Select ${row.ref}`} />}
              {expanded === row.id && (
                <div data-testid={`detail-devis-${row.id}`}>
                  <a href={`/pdf/${row.id}`}>Original PDF {row.id}</a>
                  <button>Review previous work {row.id}</button>
                  <p>Replacement history {row.id}</p>
                </div>
              )}
            </article>
          )}
        />
      ))}
    </>
  );
}

describe("previous quotation versions disclosure", () => {
  it("initially renders only the current card and an accessible collapsed control", () => {
    render(<List />);
    expect(screen.getByText("CURRENT-38")).toBeVisible();
    expect(screen.queryByTestId("row-17")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Previous versions (2)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toHaveAttribute("hidden");
  });

  it("reveals full historical rows, details, PDF and recovery actions without bulk checkboxes", () => {
    render(<List />);
    const toggle = screen.getByRole("button", { name: "Previous versions (2)" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Replaced—not current/)).toBeVisible();
    expect(screen.getByTestId("row-17")).toBeVisible();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(screen.getByText("ORIGINAL-17"));
    expect(screen.getByRole("link", { name: "Original PDF 17" })).toHaveAttribute("href", "/pdf/17");
    expect(screen.getByRole("button", { name: "Review previous work 17" })).toBeVisible();
    expect(screen.getByText("Replacement history 17")).toBeVisible();
    fireEvent.click(toggle);
    expect(screen.getByTestId("row-17")).not.toBeVisible();
    expect(screen.getByText("CURRENT-38")).toBeVisible();
  });

  it("lazy-mounts historical editors and preserves unfinished input across close and reopen", () => {
    const group = groupQuotationVersions(rows, history)[0];
    render(
      <QuotationVersionGroup
        group={group}
        renderRow={(row, historical) => historical
          ? <HistoricalEditor id={row.id} />
          : <p>{row.ref}</p>}
      />,
    );
    expect(screen.queryByLabelText("Historical draft 17")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Previous versions (2)" });
    fireEvent.click(toggle);
    const input = screen.getByLabelText("Historical draft 17");
    fireEvent.change(input, { target: { value: "Unfinished architect notes" } });
    fireEvent.click(toggle);
    expect(input).toBeInTheDocument();
    expect(input).not.toBeVisible();
    expect(input).toHaveValue("Unfinished architect notes");
    fireEvent.click(toggle);
    expect(screen.getByLabelText("Historical draft 17")).toBe(input);
    expect(input).toBeVisible();
    expect(input).toHaveValue("Unfinished architect notes");
  });

  it("old-reference search preserves the current card and auto-reveals the matching old row", () => {
    render(<List />);
    fireEvent.change(screen.getByLabelText("Search quotations"), { target: { value: "ORIGINAL-17" } });
    expect(screen.getByText("CURRENT-38")).toBeVisible();
    expect(screen.getByTestId("row-17")).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous versions (2)" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("allows collapsing auto-revealed search results, then reveals on a different match", () => {
    render(<List />);
    const input = screen.getByLabelText("Search quotations");
    fireEvent.change(input, { target: { value: "ORIGINAL-17" } });
    fireEvent.click(screen.getByRole("button", { name: "Previous versions (2)" }));
    expect(screen.getByTestId("row-17")).not.toBeVisible();
    fireEvent.change(input, { target: { value: "REVISION-24" } });
    expect(screen.getByTestId("row-24")).toBeVisible();
  });

  it("direct links mount the expanded historical detail with its existing opening-scroll target", () => {
    render(<List directLinkId={17} />);
    expect(screen.getByTestId("detail-devis-17")).toBeVisible();
    expect(screen.getByText("CURRENT-38")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Search quotations"), { target: { value: "NO MATCH" } });
    expect(screen.getByTestId("detail-devis-17")).toBeVisible();
  });

  it("handles late history loading without losing the linked historical row", () => {
    const { rerender } = render(<List directLinkId={17} historyAvailable={false} />);
    expect(screen.getByTestId("detail-devis-17")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Previous versions (2)" })).not.toBeInTheDocument();
    rerender(<List directLinkId={17} />);
    expect(screen.getByTestId("detail-devis-17")).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous versions (2)" })).toHaveAttribute("aria-expanded", "true");
  });

  it("retains the one-shot opening scroll after history resolves and the old row moves under its successor", () => {
    vi.useFakeTimers();
    const scroll = vi.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    try {
      const { rerender } = render(<List directLinkId={17} historyAvailable={false} />);
      act(() => vi.advanceTimersByTime(150));
      expect(scroll).not.toHaveBeenCalled();
      rerender(<List directLinkId={17} />);
      const detail = screen.getByTestId("detail-devis-17");
      act(() => vi.advanceTimersByTime(150));
      expect(scroll).toHaveBeenCalledExactlyOnceWith({ behavior: "smooth", block: "start" });
      expect(scroll.mock.instances[0]).toBe(detail);
      rerender(<List directLinkId={17} />);
      act(() => vi.advanceTimersByTime(150));
      expect(scroll).toHaveBeenCalledTimes(1);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("does not add empty version controls to unrelated standalone cards", () => {
    render(<List historyAvailable={false} />);
    expect(screen.queryByText(/Previous versions/)).not.toBeInTheDocument();
    expect(screen.getByTestId("row-17")).toBeVisible();
    expect(screen.getByTestId("row-24")).toBeVisible();
    expect(screen.getByTestId("row-38")).toBeVisible();
  });
});
