/**
 * Classification of database failures raised inside background intake jobs.
 *
 * Drizzle wraps driver failures as "Failed query: <sql> params: <...>" and
 * keeps the real reason (connection dropped, timeout, deadlock …) on `cause`.
 * Treating that wrapper as a permanent failure dead-lettered healthy uploads
 * after a single infrastructure blip, and storing only the wrapper message
 * lost the actual reason. These helpers walk the cause chain so the queue
 * retries infrastructure failures (bounded by MAX_INTAKE_ATTEMPTS) and
 * records the underlying reason.
 */

// SQLSTATE classes that describe the request itself (bad data, constraint,
// syntax/undefined object, raised exception). Retrying cannot fix these.
const PERMANENT_SQLSTATE_CLASSES = new Set(["22", "23", "42", "P0", "2B", "2D", "44"]);

const TRANSIENT_SQLSTATES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
  "57014", // query_canceled (statement timeout)
  "57P01", "57P02", "57P03", // admin/crash shutdown, cannot connect now
  "53300", // too_many_connections
]);

const TRANSIENT_NODE_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH",
]);

const TRANSIENT_MESSAGE = /connection terminated|connection timeout|timeout exceeded when trying to connect|connection error|socket hang up|server closed the connection|terminating connection/i;

function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  while (current != null && chain.length < 6 && !chain.includes(current)) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function codeOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" ? code : undefined;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isDrizzleQueryWrapper(e: unknown): boolean {
  return e instanceof Error && (e.name === "DrizzleQueryError" || e.message.startsWith("Failed query:"));
}

/** True when a database failure is worth another bounded attempt. */
export function isTransientDatabaseError(err: unknown): boolean {
  const chain = causeChain(err);
  for (const e of chain) {
    const code = codeOf(e);
    if (code) {
      if (TRANSIENT_SQLSTATES.has(code) || TRANSIENT_NODE_CODES.has(code) || code.startsWith("08")) return true;
      if (code.length === 5 && PERMANENT_SQLSTATE_CLASSES.has(code.slice(0, 2))) return false;
    }
    if (TRANSIENT_MESSAGE.test(messageOf(e))) return true;
  }
  // A bare Drizzle wrapper whose reason was not a request error (no
  // permanent SQLSTATE found above) is an infrastructure failure.
  return chain.some(isDrizzleQueryWrapper);
}

/** Error text including the underlying cause(s), for diagnostics. */
export function describeErrorWithCause(err: unknown): string {
  const chain = causeChain(err);
  const parts = chain.map((e, i) => {
    const code = codeOf(e);
    let msg = messageOf(e);
    // Keep the SQL wrapper short so the real reason fits the stored budget.
    if (i === 0 && isDrizzleQueryWrapper(e) && chain.length > 1) msg = msg.split("\n")[0].slice(0, 160);
    return code ? `${msg} [${code}]` : msg;
  });
  if (chain.length === 1 && isDrizzleQueryWrapper(err)) parts.push("(no underlying database reason was reported)");
  return parts.join(" | caused by: ");
}
