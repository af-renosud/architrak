import type { QueryKey } from "@tanstack/react-query";
import { projectScopedKey } from "./queryClient";

/**
 * Manual certificate previews depend on mutable fiscal configuration and
 * cumulative payment state that are not part of the form inputs. They must be
 * considered stale immediately so disabling/re-enabling the dialog query
 * always obtains a fresh server decision.
 */
export const manualCertificatPreviewQueryOptions = {
  staleTime: 0,
  refetchOnMount: "always",
  refetchOnWindowFocus: true,
} as const;

export function manualCertificatPreviewKey(
  projectId: string | number,
  ...inputs: unknown[]
): QueryKey {
  return [
    ...projectScopedKey(projectId, "certificats", "manual-preview"),
    ...inputs,
  ];
}