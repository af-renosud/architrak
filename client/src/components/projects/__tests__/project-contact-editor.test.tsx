// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@shared/schema";
import { ProjectContactEditor } from "../ProjectContactEditor";
import { goToQuotationTarget } from "@/components/devis/action-requirements";
import { apiRequest, projectScopedKey, queryClient } from "@/lib/queryClient";

vi.mock("@/lib/queryClient", () => ({
  apiRequest: vi.fn(),
  projectScopedKey: (id: string, resource?: string) => ["/api/projects", id, ...(resource ? [resource] : [])],
  queryClient: { setQueryData: vi.fn(), invalidateQueries: vi.fn() },
}));
const project = { id: 9, clientContactName: "Camille Morel", clientContactEmail: "camille@example.test" } as Project;
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);
it("opens the actual contact editor from a quotation target, focuses its field and saves through the existing project API", async () => {
  vi.mocked(apiRequest).mockResolvedValue({ json: async () => ({ ...project, clientContactName: "Camille Dubois" }) } as Response);
  render(<QueryClientProvider client={new QueryClient()}><ProjectContactEditor project={project} isArchived={false} /></QueryClientProvider>);
  act(() => goToQuotationTarget(42, "contact", 8));
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => goToQuotationTarget(42, "contact", 9));
  expect(screen.getByRole("dialog")).toHaveTextContent("Client signing contact");
  await waitFor(() => expect(screen.getByLabelText("Contact name")).toHaveFocus());
  fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Camille Dubois" } });
  fireEvent.click(screen.getByRole("button", { name: "Save contact" }));
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("PATCH", "/api/projects/9", { clientContactName: "Camille Dubois", clientContactEmail: "camille@example.test" }));
  expect(queryClient.setQueryData).toHaveBeenCalledWith(projectScopedKey("9"), expect.objectContaining({ clientContactName: "Camille Dubois" }));
  expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: projectScopedKey("9", "devis-readiness") });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("preserves a failed contact edit, provides retry, and never sends a quotation on save", async () => {
  vi.mocked(apiRequest).mockRejectedValueOnce(new Error("Contact save unavailable")).mockResolvedValueOnce({ json: async () => project } as Response);
  render(<QueryClientProvider client={new QueryClient()}><ProjectContactEditor project={project} isArchived={false} /></QueryClientProvider>);
  act(() => goToQuotationTarget(42, "contact", 9));
  fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Retained draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Save contact" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Your edits are preserved");
  expect(screen.getByLabelText("Contact name")).toHaveValue("Retained draft");
  fireEvent.click(screen.getByRole("button", { name: "Save contact" }));
  await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));
  expect(vi.mocked(apiRequest).mock.calls.every(call => call[0] === "PATCH" && call[1] === "/api/projects/9")).toBe(true);
});
