// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { LinkExistingCertificateDialog } from "../LinkExistingCertificateDialog";
import { CertificateLateInvoicesSection } from "@/components/certificats/CertificateLateInvoicesSection";
import { projectScopedKey, queryClient } from "@/lib/queryClient";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const preview = {
  invoice: { id: 41, invoiceNumber: "F-041", amountHt: "1823.74", amountTtc: "2006.11", devisId: 35 },
  expectedVersion: "version-1",
  candidates: [
    { id: 72, certificateRef: "CP-072", status: "issued", dateIssued: "2026-03-19", netToPayHt: "1823.74", netToPayTtc: "2006.11", reason: null },
    { id: 73, certificateRef: "CP-073", status: "issued", dateIssued: "2026-03-20", netToPayHt: "2458.19", netToPayTtc: "2704.01", reason: "Devis différent" },
  ],
};

function response(data: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) } as Response;
}

function openDialog(unavailable = false) {
  const onClose = vi.fn();
  render(<QueryClientProvider client={queryClient}><LinkExistingCertificateDialog invoiceId={41} projectId="12" unavailable={unavailable} onClose={onClose} /></QueryClientProvider>);
  return onClose;
}

async function fillForm() {
  const radios = await screen.findAllByRole("radio");
  fireEvent.click(radios[0]);
  fireEvent.change(screen.getByLabelText("Motif du rapprochement"), { target: { value: "Pièces et travaux identiques vérifiés." } });
  fireEvent.click(screen.getByRole("checkbox"));
}

beforeEach(() => {
  queryClient.clear();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("fetch", vi.fn(async () => response(preview)));
});
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("link an approved invoice to an issued certificate", () => {
  it("requires explicit selection, a ten-character reason and acknowledgement; exposes blocked reasons and both amounts", async () => {
    openDialog();
    const radios = await screen.findAllByRole("radio");
    const submit = screen.getByTestId("button-confirm-link-existing-certificate");
    expect(radios[0]).not.toBeChecked();
    expect(radios[1]).toBeDisabled();
    expect(screen.getByText("Indisponible — Devis différent")).toBeVisible();
    expect(screen.getAllByText("HT").length).toBe(3);
    expect(screen.getAllByText("TTC").length).toBe(3);
    expect(submit).toBeDisabled();
    fireEvent.click(radios[0]);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText("Motif du rapprochement"), { target: { value: "court" } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Motif du rapprochement"), { target: { value: "Travaux vérifiés dans les originaux." } });
    expect(submit).toBeEnabled();
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  });

  it("posts the exact version-bound confirmation and invalidates project and certificate data", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, options) => response(options?.method === "POST" ? {} : preview));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const onClose = openDialog();
    await fillForm();
    fireEvent.click(screen.getByTestId("button-confirm-link-existing-certificate"));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/api/invoices/41/existing-certificates", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ certificatId: 72, expectedVersion: "version-1", reason: "Pièces et travaux identiques vérifiés.", confirmed: true }),
    }));
    for (const resource of ["invoices", "certificats", "certificat-invoice-links", "certificat-payments"]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: projectScopedKey("12", resource) });
    }
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/certificats", "72", "late-invoices"] });
  });

  it("blocks resubmission after a 409 until refresh and renewed selection and confirmation", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, options) => options?.method === "POST" ? response({ message: "Version périmée" }, 409) : response(preview));
    const onClose = openDialog();
    await fillForm();
    fireEvent.click(screen.getByTestId("button-confirm-link-existing-certificate"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Aucun lien n'a été enregistré");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("button-confirm-link-existing-certificate")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Actualiser" }));
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
    expect(screen.getAllByRole("radio")[0]).not.toBeChecked();
    expect(screen.getByLabelText("Motif du rapprochement")).toHaveValue("");
    expect(screen.getByTestId("button-confirm-link-existing-certificate")).toBeDisabled();
  });

  it("presents an empty candidate list without allowing a write", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ ...preview, candidates: [] }));
    openDialog();
    expect(await screen.findByText("Aucun certificat existant disponible")).toBeVisible();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByTestId("button-confirm-link-existing-certificate")).toBeDisabled();
  });

  it("shows a readable preview error with working retry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: "Service indisponible" }, 503)).mockResolvedValue(response(preview));
    openDialog();
    expect(await screen.findByRole("alert")).toHaveTextContent("Service indisponible");
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(await screen.findAllByRole("radio")).toHaveLength(2);
  });

  it("locks the form if the project or live invoice status becomes unavailable", async () => {
    openDialog(true);
    const radios = await screen.findAllByRole("radio");
    expect(radios[0]).toBeDisabled();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByTestId("button-confirm-link-existing-certificate")).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("projet archivé");
  });
});

describe("certificate post-issue invoice history", () => {
  it("renders amounts, reason, actor and timestamp as read-only post-issue history", async () => {
    vi.mocked(fetch).mockResolvedValue(response([{ invoiceId: 41, invoiceNumber: "F-041", amountHt: "1823.74", amountTtc: "2006.11", reason: "Originaux vérifiés", actor: "Camille Laurent", linkedAt: "2026-03-21T14:12:00Z" }]));
    render(<QueryClientProvider client={queryClient}><CertificateLateInvoicesSection certificatId={72} /></QueryClientProvider>);
    expect(await screen.findByTestId("late-invoice-41")).toHaveTextContent("Originaux vérifiés");
    expect(screen.getByTestId("late-invoice-41")).toHaveTextContent("Camille Laurent");
    expect(screen.getByTestId("late-invoice-41")).toHaveTextContent("21/03/2026");
    expect(screen.getByText("Factures liées après émission")).toBeVisible();
    expect(screen.getByText(/distincts des factures sources d'origine/)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/certificats/72/late-invoices", expect.objectContaining({ method: "GET", credentials: "include" }));
  });
});
