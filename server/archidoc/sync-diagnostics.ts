import type { ArchidocFetchErrorCode } from "./sync-client";

export type ArchidocSyncDiagnosticCode =
  | ArchidocFetchErrorCode
  | "catalogue_identity_conflict"
  | "catalogue_incomplete"
  | "catalogue_persistence_failed"
  | "wipe_guard"
  | "sync_failure";

export interface SafeArchidocSyncFailure {
  code: ArchidocSyncDiagnosticCode;
  reason: string;
}

const KNOWN_FAILURES: Array<{
  code: ArchidocSyncDiagnosticCode;
  matches: (message: string) => boolean;
  reason: string;
}> = [
  {
    code: "not_configured",
    matches: (message) => message.includes("not_configured") || message === "Not configured",
    reason: "ArchiDoc sync is not configured.",
  },
  {
    code: "invalid_configuration",
    matches: (message) => message.includes("invalid_configuration"),
    reason: "The ArchiDoc sync configuration is invalid.",
  },
  {
    code: "unauthorized",
    matches: (message) => message.includes("unauthorized"),
    reason: "ArchiDoc rejected the configured sync credential.",
  },
  {
    code: "not_found",
    matches: (message) => message.includes("not_found"),
    reason: "The configured ArchiDoc host does not expose the requested resource.",
  },
  {
    code: "unavailable",
    matches: (message) => message.includes("unavailable"),
    reason: "ArchiDoc is temporarily unavailable.",
  },
  {
    code: "http_error",
    matches: (message) => message.includes("http_error"),
    reason: "ArchiDoc returned an unexpected HTTP response.",
  },
  {
    code: "timeout",
    matches: (message) => message.includes("timeout"),
    reason: "The ArchiDoc request timed out.",
  },
  {
    code: "network_error",
    matches: (message) => message.includes("network_error"),
    reason: "The ArchiDoc request failed before an HTTP response was received.",
  },
  {
    code: "invalid_response",
    matches: (message) => message.includes("invalid_response"),
    reason: "ArchiDoc returned data that failed validation.",
  },
  {
    code: "catalogue_identity_conflict",
    matches: (message) => message.includes("catalogue_identity_conflict"),
    reason: "Technical-lot source data conflicts with immutable Planning history; the local catalogue was retained.",
  },
  {
    code: "catalogue_incomplete",
    matches: (message) => message.includes("catalogue_incomplete"),
    reason: "The technical-lot response was incomplete; the local catalogue was retained.",
  },
  {
    code: "catalogue_persistence_failed",
    matches: (message) => message.includes("catalogue_persistence_failed"),
    reason: "Technical-lot catalogue publication failed; the local catalogue was retained.",
  },
  {
    code: "wipe_guard",
    matches: (message) => message.startsWith("WARNING:"),
    reason: "A mirror safeguard retained local data after an incomplete upstream response.",
  },
];

export function toSafeArchidocSyncFailure(errorMessage: string | null | undefined): SafeArchidocSyncFailure | null {
  if (!errorMessage) return null;

  const normalized = errorMessage.toLowerCase();
  const known = KNOWN_FAILURES.find(({ matches }) => matches(normalized) || matches(errorMessage));
  if (known) {
    return { code: known.code, reason: known.reason };
  }
  return {
    code: "sync_failure",
    reason: "The latest ArchiDoc sync failed. Check the safe deployment diagnostics.",
  };
}