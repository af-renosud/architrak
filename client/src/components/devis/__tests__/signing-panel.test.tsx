// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * FE coverage for the Send-to-Signature dialog (Task #227).
 *
 * Pins:
 *   - Dialog opens when the architect clicks the panel CTA, and the
 *     textarea is visible on the first-send branch.
 *   - Confirming the dialog forwards the trimmed message to the
 *     send-to-signer endpoint as { message: "..." }.
 *   - On the resume branch (archisignEnvelopeId already persisted) the
 *     textarea is HIDDEN and the resume-specific copy is rendered; the
 *     mutation fires without a body.
 */

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const apiRequestMock = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...args: unknown[]) => apiRequestMock(...args),
  queryClient: {
    invalidateQueries: vi.fn(),
  },
}));

import { SigningPanel } from "../SigningPanel";

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function renderWithDevis(devis: Record<string, unknown>, isArchived = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["/api/devis", (devis as { id: number }).id], devis);
  return render(
    <QueryClientProvider client={client}>
      <SigningPanel
        devisId={(devis as { id: number }).id}
        isArchived={isArchived}
      />
    </QueryClientProvider>,
  );
}

const baseDevis = {
  id: 42,
  devisCode: "LOT01-001",
  signOffStage: "approved_for_signing",
  archisignEnvelopeId: null,
  archisignAccessUrl: null,
  archisignOtpDestination: null,
  archisignEnvelopeStatus: null,
  archisignEnvelopeExpiresAt: null,
  archisignAccessUrlInvalidatedAt: null,
  signedPdfStorageKey: null,
};

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockResolvedValue(jsonResponse({ ok: true }));
});

describe("SigningPanel — first-send branch", () => {
  it("opens the dialog with the personalised-message textarea on click", () => {
    renderWithDevis(baseDevis);
    fireEvent.click(screen.getByTestId("button-send-to-signer-42"));
    const dialog = screen.getByTestId("dialog-send-to-signer-42");
    expect(dialog).toBeVisible();
    expect(screen.getByTestId("textarea-send-message-42")).toBeVisible();
    expect(screen.getByTestId("text-send-message-count-42")).toHaveTextContent("0 / 2000");
  });

  it("forwards the trimmed message to send-to-signer on confirm", async () => {
    renderWithDevis(baseDevis);
    fireEvent.click(screen.getByTestId("button-send-to-signer-42"));

    const textarea = screen.getByTestId("textarea-send-message-42") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "  Bonjour, voici le devis pour signature.  " },
    });

    fireEvent.click(screen.getByTestId("button-send-to-signer-confirm-42"));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));
    expect(apiRequestMock).toHaveBeenCalledWith(
      "POST",
      "/api/devis/42/send-to-signer",
      { message: "Bonjour, voici le devis pour signature." },
    );
  });

  it("sends an empty body when the textarea is left blank", async () => {
    renderWithDevis(baseDevis);
    fireEvent.click(screen.getByTestId("button-send-to-signer-42"));
    fireEvent.click(screen.getByTestId("button-send-to-signer-confirm-42"));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));
    expect(apiRequestMock).toHaveBeenCalledWith(
      "POST",
      "/api/devis/42/send-to-signer",
      {},
    );
  });
});

describe("SigningPanel — resume branch", () => {
  const resumeDevis = {
    ...baseDevis,
    archisignEnvelopeId: "env_existing",
    archisignAccessUrl: "https://archisign.test/e/existing",
    archisignOtpDestination: "+33 6 11 22 33 44",
    archisignEnvelopeStatus: null,
  };

  it("hides the textarea and shows the resume-specific copy", () => {
    renderWithDevis(resumeDevis);
    expect(screen.getByTestId("button-send-to-signer-42")).toHaveTextContent(
      /Réessayer l'envoi/,
    );
    fireEvent.click(screen.getByTestId("button-send-to-signer-42"));
    const dialog = screen.getByTestId("dialog-send-to-signer-42");
    expect(dialog).toBeVisible();
    // The personalised-message textarea must not be present on resume.
    expect(screen.queryByTestId("textarea-send-message-42")).toBeNull();
    expect(dialog).toHaveTextContent(
      /enveloppe a déjà été créée chez Archisign/i,
    );
  });

  it("fires the mutation without a message on confirm", async () => {
    renderWithDevis(resumeDevis);
    fireEvent.click(screen.getByTestId("button-send-to-signer-42"));
    fireEvent.click(screen.getByTestId("button-send-to-signer-confirm-42"));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));
    expect(apiRequestMock).toHaveBeenCalledWith(
      "POST",
      "/api/devis/42/send-to-signer",
      {},
    );
  });
});
