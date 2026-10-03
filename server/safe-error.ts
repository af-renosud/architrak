/**
 * Credential-safe diagnostics. Never serialize an exception, message, stack,
 * query, parameters, request/response, or arbitrary code/name. Drivers and OAuth
 * clients put secrets in all of those fields. Only fixed categories leave here.
 */
export function safeErrorDiagnostic(error: unknown): string {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth++) {
    seen.add(current);
    if (typeof current !== "object") break;
    try {
      const e = current as Record<string, unknown>;
      const codes: Record<string, string> = {
        "23505": "database_unique_violation",
        "23503": "database_foreign_key_violation",
        "23502": "database_not_null_violation",
        "23514": "database_check_violation",
        "40001": "database_serialization_failure",
        "40P01": "database_deadlock",
        "28P01": "database_authentication_failed",
        ECONNREFUSED: "connection_refused",
        ECONNRESET: "connection_reset",
        ETIMEDOUT: "connection_timeout",
        invalid_grant: "oauth_reauthorization_required",
        invalid_token: "oauth_reauthorization_required",
      };
      if (typeof e.code === "string" && Object.prototype.hasOwnProperty.call(codes, e.code)) {
        return codes[e.code];
      }
      for (const status of [e.status, e.statusCode, e.code]) {
        if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
          return `http_${status}`;
        }
      }
      current = e.cause;
    } catch {
      // Even getters/proxies on a thrown value must not break the error path.
      break;
    }
  }
  return "operation_failed";
}