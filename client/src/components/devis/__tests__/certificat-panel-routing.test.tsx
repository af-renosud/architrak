// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  QueryClient,
  QueryClientProvider,
  type QueryFunction,
} from "@tanstack/react-query";

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("@/components/factures/FacturesTab", () => ({
  CreateMultiCertificatDialog: ({
    invoices,
  }: {
    invoices: Array<{ id: number }>;
  }) => (
    <div data-testid="grouped-source-dialog">
      {invoices.map((invoice) => invoice.id).join(",")}
    </div>
  ),
}));

import { CertificatPanel } from "../CertificatPanel";

const devis = {
  id: 42,
  projectId: 9,
  contractorId: 7,
  devisCode: "D-42",
  signOffStage: "client_signed_off",
  acompteInvoiceId: null,
};
const contractor = {
  id: 7,
  name: "Entreprise Test",
  iban: "FR7630006000011234567890189",
  archidocPartnerType: "contractor",
};
const approvedInvoice = {
  id: 88,
  projectId: 9,
  devisId: 42,
  contractorId: 7,
  status: "approved",
  datePaid: null,
};

function renderPanel({
  queryFn,
  contractorData = contractor,
  onCreateManual = vi.fn(),
}: {
  queryFn: QueryFunction;
  contractorData?: typeof contractor;
  onCreateManual?: (context: { contractorId: number; devisId: number }) => void;
}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { queryFn, retry: false, staleTime: Infinity },
    },
  });
  client.setQueryData(["/api/devis", 42], devis);
  client.setQueryData(["/api/projects", "9", "invoices"], []);
  client.setQueryData(["/api/projects", "9", "certificat-invoice-links"], []);
  client.setQueryData(["/api/projects", "9", "certificats"], []);
  client.setQueryData(["/api/contractors"], [contractorData]);

  render(
    <QueryClientProvider client={client}>
      <CertificatPanel
        devisId={42}
        projectId={9}
        isArchived={false}
        onCreateManual={onCreateManual}
      />
    </QueryClientProvider>,
  );
  return { onCreateManual };
}

beforeEach(() => {
  toastSpy.mockReset();
});

describe("CertificatPanel creation routing", () => {
  it("refetches cached-empty sources and opens grouped creation for a newly approved invoice", async () => {
    const queryFn = vi.fn(async ({ queryKey }) => {
      if (queryKey.at(-1) === "invoices") return [approvedInvoice];
      if (queryKey.at(-1) === "certificat-invoice-links") return [];
      if (queryKey[0] === "/api/contractors") return [contractor];
      throw new Error(`Unexpected query ${queryKey.join("/")}`);
    });
    const onCreateManual = vi.fn();
    renderPanel({ queryFn, onCreateManual });

    expect(screen.getByTestId("button-create-certificat-42")).toHaveTextContent(
      "Create in project",
    );
    fireEvent.click(screen.getByTestId("button-create-certificat-42"));

    expect(await screen.findByTestId("grouped-source-dialog")).toHaveTextContent(
      "88",
    );
    expect(onCreateManual).not.toHaveBeenCalled();
    expect(queryFn).toHaveBeenCalledTimes(3);
  });

  it("keeps a supplier with no approved invoice blocked from manual creation", () => {
    const onCreateManual = vi.fn();
    renderPanel({
      queryFn: vi.fn(),
      contractorData: {
        ...contractor,
        archidocPartnerType: "supplier",
      },
      onCreateManual,
    });

    expect(screen.getByTestId("button-create-certificat-42")).toBeDisabled();
    expect(screen.getByTestId("button-create-certificat-42")).toHaveTextContent(
      "No eligible invoices",
    );
    expect(screen.queryByTestId("grouped-source-dialog")).not.toBeInTheDocument();
    expect(onCreateManual).not.toHaveBeenCalled();
  });

  it("surfaces a refetch failure without opening either creation flow", async () => {
    const queryFn = vi.fn(async ({ queryKey }) => {
      if (queryKey.at(-1) === "invoices") {
        throw new Error("Invoice refresh failed");
      }
      if (queryKey.at(-1) === "certificat-invoice-links") return [];
      if (queryKey[0] === "/api/contractors") return [contractor];
      throw new Error(`Unexpected query ${queryKey.join("/")}`);
    });
    const onCreateManual = vi.fn();
    renderPanel({ queryFn, onCreateManual });

    fireEvent.click(screen.getByTestId("button-create-certificat-42"));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Impossible de préparer le certificat",
          description: "Invoice refresh failed",
          variant: "destructive",
        }),
      ),
    );
    expect(screen.queryByTestId("grouped-source-dialog")).not.toBeInTheDocument();
    expect(onCreateManual).not.toHaveBeenCalled();
  });
});