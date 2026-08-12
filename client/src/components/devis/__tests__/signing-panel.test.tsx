// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * FE coverage for the Send-to-Signature dialog (Task #227, reworked by
 * Task #257 into a mandatory two-step flow).
 *
 * Pins:
 *   - First-send branch opens a two-step dialog: compose (pre-filled
 *     editable template, min 20 chars enforced) → recap (recipient /
 *     devis / message) → confirm.
 *   - "Continuer" is disabled while the trimmed message is under the
 *     minimum, and the min-length hint is shown.
 *   - Confirming from the recap forwards the trimmed message as
 *     { message: "..." }; there is no way to send without one.
 *   - The back button returns to compose with the text preserved.
 *   - A `contextEmail.status === "failed"` in the response raises a
 *     destructive toast (envelope NOT rolled back).
 *   - Resume branch (archisignEnvelopeId persisted): textarea hidden,
 *     resume copy shown, single confirm fires with an empty body.
 */

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
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

function renderWithDevis(
  devis: Record<string, unknown>,
  opts: { isArchived?: boolean; project?: Record<string, unknown> } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["/api/devis", (devis as { id: number }).id], devis);
  if (opts.project) {
    client.setQueryData(
      ["/api/projects", (devis as { projectId: number }).projectId],
      opts.project,
    );
  }
  return render(
    <QueryClientProvider client={client}>
      <SigningPanel
        devisId={(devis as { id: number }).id}
        isArchived={opts.isArchived ?? false}
      />
    </QueryClientProvider>,
  );
}

const baseDevis = {
  id: 42,
  devisCode: "LOT01-001",
  devisNumber: "DVT0000042",
  descriptionFr: "Plomberie générale",
  amountTtc: "1200.00",
  signOffStage: "approved_for_signing",
  archisignEnvelopeId: null,
  archisignAccessUrl: null,
  archisignOtpDestination: null,
  archisignEnvelopeStatus: null,
  archisignEnvelopeExpiresAt: null,
  archisignAccessUrlInvalidatedAt: null,
  archisignSignerMessage: null,
  signedPdfStorageKey: null,
};

const VALID_MESSAGE = "Bonjour, voici le devis pour signature électronique.";

beforeEach(() => {
  apiRequestMock.mockReset();
  toastSpy.mockReset();
  apiRequestMock.mockResolvedValue(jsonResponse({ ok: true }));
});

describe("SigningPanel — first-send branch (two-step, Task #257)", () => {
  it("opens on step 1 with the pre-filled template and no confirm button yet", () => {
    renderWithDevis(baseDevis);
    fireEvent.click(screen.getByTestId("button-send-to-signer-42"));

    const dialog = screen.getByTestId("dialog-send-to-signer-42");
    expect(dialog).toBeVisible();
    expect(dialog).toHaveTextContent(/Step 1 of 2/);

    const textarea = screen.getByTestId("textarea-send-message-42") as HTMLTextAreaElement;
    expect(textarea).toBeVisible();
    // Template is pre-filled with the devis reference.
    expect(textarea.value).toContain("DVT0000042");
    expect(textarea.value).toMatch(/^Dear/);

    expect(screen.getByTestId("button-send-to-signer-continue-42")).toBeEnabled();
    // The final confirm only exists on the recap step.
    expect(screen.queryByTestId("button-send-to-signer-confirm-42")).toBeNull();
  });

  it("disables Continuer and shows the min-length hint under 20 chars", () => {
    renderWithDevis(baseDevis);
    fireEvent.click(screen.getByTestId("button-send-to-signer-42"));

    const textarea = screen.getByTestId("textarea-send-message-42");
    fireEvent.change(textarea, { target: { value: "Trop court" } });

    expect(screen.getByTestId("button-send-to-signer-continue-42")).toBeDisabled();
    expect(screen.getByTestId("text-send-message-min-42")).toHaveTextContent(
      /Minimum 20 characters/,
    );

    // Whitespace padding must not count.
    fireEvent.change(textarea, { target: { value: "Court" + " ".repeat(40) } });
    expect(screen.getByTestId("button-send-to-signer-continue-42")).toBeDisabled();
  });

  it("recap shows the message + devis ref, and confirm sends { message } trimmed", async () => {
    renderWithDevis(
      { ...baseDevis, projectId: 9 },
      {
        project: {
          id: 9,
          name: "Villa Sophia",
          clientContactName: "Marie Dupont",
          clientContactEmail: "marie@example.test",
        },
      },
    );
    fireEvent.click(screen.getByTestId("button-send-to-signer-42"));

    fireEvent.change(screen.getByTestId("textarea-send-message-42"), {
      target: { value: `  ${VALID_MESSAGE}  ` },
    });
    fireEvent.click(screen.getByTestId("button-send-to-signer-continue-42"));

    const dialog = screen.getByTestId("dialog-send-to-signer-42");
    expect(dialog).toHaveTextContent(/Step 2 of 2/);
    expect(screen.getByTestId("text-recap-message-42")).toHaveTextContent(VALID_MESSAGE);
    expect(screen.getByTestId("text-recap-devis-42")).toHaveTextContent("DVT0000042");
    expect(screen.getByTestId("text-recap-recipient-42")).toHaveTextContent(
      "Marie Dupont (marie@example.test)",
    );
    // The textarea is gone on the recap step.
    expect(screen.queryByTestId("textarea-send-message-42")).toBeNull();

    fireEvent.click(screen.getByTestId("button-send-to-signer-confirm-42"));
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));
    expect(apiRequestMock).toHaveBeenCalledWith(
      "POST",
      "/api/devis/42/send-to-signer",
      { message: VALID_MESSAGE },
    );
  });

  it("back button returns to compose with the text preserved", () => {
    renderWithDevis(baseDevis);
    fireEvent.click(screen.getByTestId("button-send-to-signer-42"));

    fireEvent.change(screen.getByTestId("textarea-send-message-42"), {
      target: { value: VALID_MESSAGE },
    });
    fireEvent.click(screen.getByTestId("button-send-to-signer-continue-42"));
    fireEvent.click(screen.getByTestId("button-send-to-signer-back-42"));

    const textarea = screen.getByTestId("textarea-send-message-42") as HTMLTextAreaElement;
    expect(textarea.value).toBe(VALID_MESSAGE);
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  it("raises a destructive toast when the response reports contextEmail failed", async () => {
    apiRequestMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        contextEmail: { status: "failed", error: "gmail down" },
      }),
    );
    renderWithDevis(baseDevis);
    fireEvent.click(screen.getByTestId("button-send-to-signer-42"));
    fireEvent.change(screen.getByTestId("textarea-send-message-42"), {
      target: { value: VALID_MESSAGE },
    });
    fireEvent.click(screen.getByTestId("button-send-to-signer-continue-42"));
    fireEvent.click(screen.getByTestId("button-send-to-signer-confirm-42"));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: expect.stringMatching(/Context email NOT sent/),
        }),
      ),
    );
  });
});

describe("SigningPanel — upstream error detail surfacing (Task #440)", () => {
  function apiError(status: number, body: Record<string, unknown>) {
    const err = new Error(
      typeof body.message === "string" ? body.message : `${status}`,
    ) as Error & { status: number; data: unknown };
    err.status = status;
    err.data = body;
    return err;
  }

  async function sendFirstAttempt() {
    renderWithDevis(baseDevis);
    fireEvent.click(screen.getByTestId("button-send-to-signer-42"));
    fireEvent.change(screen.getByTestId("textarea-send-message-42"), {
      target: { value: VALID_MESSAGE },
    });
    fireEvent.click(screen.getByTestId("button-send-to-signer-continue-42"));
    fireEvent.click(screen.getByTestId("button-send-to-signer-confirm-42"));
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));
  }

  it("shows the upstream detail from the 503 body on the archisign_unavailable toast", async () => {
    apiRequestMock.mockRejectedValue(
      apiError(503, {
        message:
          "Le service de signature Archisign est momentanément indisponible — réessayez dans quelques minutes.",
        code: "archisign_unavailable",
        detail: '{"error":"vault_transient","message":"Invalid IP address: undefined"}',
      }),
    );
    await sendFirstAttempt();

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: "destructive",
          title: "Archisign temporarily unavailable",
        }),
      ),
    );
    // The description is JSX — render it and assert the technical detail
    // line carries the upstream body, styled as secondary text.
    const { description } = toastSpy.mock.calls[0][0] as {
      description: React.ReactElement;
    };
    render(<>{description}</>);
    const detailEl = screen.getByTestId("text-archisign-error-detail-42");
    expect(detailEl).toHaveTextContent(
      'Technical detail: {"error":"vault_transient","message":"Invalid IP address: undefined"}',
    );
    expect(detailEl.className).toContain("text-xs");
  });

  it("appends the detail on non-outage failures (archisign_create_failed) too", async () => {
    apiRequestMock.mockRejectedValue(
      apiError(502, {
        message: "Failed to create the Archisign envelope.",
        code: "archisign_create_failed",
        detail: "Archisign 400: signer email rejected",
      }),
    );
    await sendFirstAttempt();

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive", title: "Send failed" }),
      ),
    );
    const { description } = toastSpy.mock.calls[0][0] as {
      description: React.ReactElement;
    };
    render(<>{description}</>);
    expect(screen.getByTestId("text-archisign-error-detail-42")).toHaveTextContent(
      "Technical detail: Archisign 400: signer email rejected",
    );
  });

  it("omits the technical-detail line when the body has no detail", async () => {
    apiRequestMock.mockRejectedValue(
      apiError(503, {
        message: "Archisign is not configured (missing API key or base URL).",
        code: "archisign_unconfigured",
      }),
    );
    await sendFirstAttempt();

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive", title: "Send failed" }),
      ),
    );
    const { description } = toastSpy.mock.calls[0][0] as {
      description: React.ReactElement;
    };
    render(<>{description}</>);
    expect(screen.queryByTestId("text-archisign-error-detail-42")).toBeNull();
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
      /Retry send/,
    );
    fireEvent.click(screen.getByTestId("button-send-to-signer-42"));
    const dialog = screen.getByTestId("dialog-send-to-signer-42");
    expect(dialog).toBeVisible();
    // No compose step on resume — the persisted message cannot be changed.
    expect(screen.queryByTestId("textarea-send-message-42")).toBeNull();
    expect(screen.queryByTestId("button-send-to-signer-continue-42")).toBeNull();
    expect(dialog).toHaveTextContent(
      /envelope has already been created at Archisign/i,
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
