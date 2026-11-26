// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { ClientShareSection, ComparisonView } from "../WorksheetAgreementPanel";

afterEach(() => cleanup());

const payload = (revision: number) => ({
  basis: { kind: "revision_request", requestId: revision, revision, at: "2026-11-20T10:00:00Z" },
  worksheetChangedSinceBasis: false, undeliveredRequest: null,
  target: { id: 9, code: "Q2", number: null, amountHt: null, lineCount: 0 },
  agreedOriginalHtCents: 0,
  comparison: { rows: [], agreedHtCents: 0, revisedLinesHtCents: 0, counts: { as_agreed: 0, quantity_differs: 0, price_differs: 0,
    total_differs: 0, missing: 0, removed_as_agreed: 0, still_included: 0, not_in_worksheet: 0 } },
});

it("recomputes the comparison every time it is reopened, even with an app-wide infinite cache", async () => {
  let revision = 1;
  const queryFn = vi.fn(async () => payload(revision));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn } } });
  const view = () => <QueryClientProvider client={client}><ComparisonView worksheetId={1} targetId={9} /></QueryClientProvider>;
  const first = render(view());
  await screen.findByText(/version 1\)/);
  first.unmount();
  revision = 2; // e.g. a new revision request was delivered in between
  render(view());
  await screen.findByText(/version 2\)/);
  await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  expect((queryFn.mock.calls[0] as unknown as [{ queryKey: unknown }])[0].queryKey).toEqual(["/api/worksheets", 1, "comparison", 9]);
});

it("picks up a client link created elsewhere and new client comments when the worksheet is reopened", async () => {
  let state: any = { worksheetRevision: 3, hasActiveLink: false, unreadComments: 0, englishBlocker: null, releases: [] };
  const queryFn = vi.fn(async () => state);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn } } });
  const view = () => <QueryClientProvider client={client}>
    <ClientShareSection worksheetId={1} devisId={5} projectId={7} revision={3} readOnly={false} flush={async () => undefined} />
  </QueryClientProvider>;
  const first = render(view());
  await screen.findByTestId("text-worksheet-no-link");
  expect(screen.queryByTestId("button-worksheet-share")).toBeNull();
  first.unmount();
  state = { ...state, hasActiveLink: true, unreadComments: 1, releases: [{ id: 4, worksheetRevision: 3, sealedAt: "2026-11-20T10:00:00Z", sealedBy: null,
    withdrawnAt: null, withdrawnBy: null, current: true, revisedTtcCents: 0,
    comments: [{ id: 8, body: "Keep the north wall", authorName: "Client", authorEmail: "c@example.com", createdAt: "2026-11-21T10:00:00Z", acknowledgedAt: null }] }] };
  render(view());
  await screen.findByText("Keep the north wall");
  expect(screen.getByTestId("badge-worksheet-unread").textContent).toContain("1 new");
  expect(screen.queryByTestId("text-worksheet-no-link")).toBeNull();
});

it("hides the share button and explains why when English wording is missing", async () => {
  const state = { worksheetRevision: 3, hasActiveLink: true, unreadComments: 0, englishBlocker: "Finalise this quotation's English translation", releases: [] };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => state } } });
  render(<QueryClientProvider client={client}>
    <ClientShareSection worksheetId={2} devisId={5} projectId={7} revision={3} readOnly={false} flush={async () => undefined} />
  </QueryClientProvider>);
  await screen.findByTestId("text-worksheet-english-blocker");
  expect(screen.queryByTestId("button-worksheet-share")).toBeNull();
});
