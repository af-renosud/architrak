// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { toastSpy, apiRequestMock, invalidateQueriesMock } = vi.hoisted(() => ({
  toastSpy: vi.fn(),
  apiRequestMock: vi.fn(),
  invalidateQueriesMock: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...args: unknown[]) => apiRequestMock(...args),
  queryClient: { invalidateQueries: invalidateQueriesMock },
  projectScopedKey: (projectId: string | number, ...parts: string[]) => [
    "/api/projects",
    String(projectId),
    ...parts,
  ],
  ApiError: class ApiError extends Error {},
}));

import { ClientPortalPanel } from "../DevisTab";

function jsonResponse(body: unknown) {
  return { json: async () => body } as Response;
}

function renderPanel(opts: {
  token?: Record<string, unknown> | null;
  delivery?: Record<string, unknown> | null;
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["/api/devis", 42, "client-check-token"], {
    token: opts.token ?? null,
    delivery: opts.delivery ?? null,
  });
  client.setQueryData(["/api/devis", 42], {
    id: 42,
    projectId: 9,
    devisCode: "LOT01-001",
    devisNumber: "DVT0000042",
  });
  client.setQueryData(["/api/projects", "9"], {
    id: 9,
    clientName: "Dupont",
    clientContactName: "Marie Dupont",
    clientContactEmail: "marie@example.test",
  });
  return render(
    <QueryClientProvider client={client}>
      <ClientPortalPanel devisId={42} projectId="9" isArchived={false} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiRequestMock.mockResolvedValue(jsonResponse({
    token: {
      id: 71,
      clientEmail: "marie@example.test",
      clientName: "Marie Dupont",
      createdAt: "2026-09-05T09:00:00.000Z",
      lastUsedAt: null,
      expiresAt: "2026-12-04T09:00:00.000Z",
      revokedAt: null,
    },
    delivery: {
      communicationId: 501,
      status: "sent",
      sentAt: "2026-09-05T09:01:00.000Z",
      recipientEmail: "marie@example.test",
      recipientName: "Marie Dupont",
      portalUrl: "https://architrak.test/p/client/secret-token_123",
    },
  }));
});

describe("ClientPortalPanel quotation-link email", () => {
  it("requires a message, reviews exact details, then sends the trimmed draft", async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("button-send-to-client-42"));

    expect(screen.getByTestId("input-client-email-42")).toHaveValue("marie@example.test");
    expect(screen.getByTestId("input-client-name-42")).toHaveValue("Marie Dupont");

    fireEvent.change(screen.getByTestId("textarea-client-link-message-42"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByTestId("button-confirm-send-to-client-42"));
    expect(screen.getByTestId("text-client-message-error-42")).toHaveTextContent(/at least 10/);

    fireEvent.change(screen.getByTestId("textarea-client-link-message-42"), {
      target: { value: "  Please review the bathroom quotation.  " },
    });
    fireEvent.click(screen.getByTestId("button-confirm-send-to-client-42"));

    const review = screen.getByTestId("review-client-link-email-42");
    expect(review).toHaveTextContent("DVT0000042");
    expect(review).toHaveTextContent("Please review the bathroom quotation.");
    expect(review).toHaveTextContent("marie@example.test");

    fireEvent.click(screen.getByTestId("button-confirm-send-to-client-42"));
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith(
      "POST",
      "/api/devis/42/client-check-token/issue",
      {
        clientEmail: "marie@example.test",
        clientName: "Marie Dupont",
        message: "Please review the bathroom quotation.",
      },
    ));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({
      title: "Link sent to client",
    })));
  });

  it("shows successful provenance and retries a failed delivery without issuing a new link", async () => {
    const token = {
      id: 71,
      clientEmail: "marie@example.test",
      clientName: "Marie Dupont",
      createdAt: "2026-09-05T09:00:00.000Z",
      lastUsedAt: null,
      expiresAt: "2026-12-04T09:00:00.000Z",
      revokedAt: null,
    };
    const view = renderPanel({
      token,
      delivery: {
        communicationId: 501,
        status: "failed",
        sentAt: null,
        recipientEmail: "marie@example.test",
        recipientName: "Marie Dupont",
        portalUrl: "https://architrak.test/p/client/secret-token_123",
      },
    });
    expect(screen.getByTestId("client-link-delivery-failed-42")).toHaveTextContent("Delivery failed");
    fireEvent.click(screen.getByTestId("button-retry-client-link-delivery-42"));
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledWith(
      "POST",
      "/api/devis/42/client-check-token/resend",
      {},
    ));
    expect(apiRequestMock).not.toHaveBeenCalledWith(
      "POST",
      "/api/devis/42/client-check-token/issue",
      expect.anything(),
    );

    view.unmount();
    renderPanel({
      token,
      delivery: {
        communicationId: 501,
        status: "sent",
        sentAt: "2026-09-05T09:01:00.000Z",
        recipientEmail: "marie@example.test",
        recipientName: "Marie Dupont",
        portalUrl: "https://architrak.test/p/client/secret-token_123",
      },
    });
    expect(screen.getByTestId("client-link-delivery-sent-42")).toHaveTextContent("marie@example.test");
    expect(screen.getByTestId("client-link-delivery-sent-42")).toHaveTextContent("05/09/2026");
  });
});