import { describe, expect, it } from "vitest";
import { describeErrorWithCause, isTransientDatabaseError } from "../services/intake/transient-db-error";

function drizzleWrapper(cause?: unknown): Error {
  const e = new Error('Failed query: select "id" from "invoices" where "invoices"."source_intake_document_id" = $1\nparams: 149');
  e.name = "DrizzleQueryError";
  if (cause !== undefined) (e as Error & { cause?: unknown }).cause = cause;
  return e;
}

function pgError(message: string, code?: string): Error {
  const e = new Error(message);
  if (code) (e as Error & { code?: string }).code = code;
  return e;
}

describe("intake transient database error classification", () => {
  it("retries a dropped connection wrapped by Drizzle", () => {
    expect(isTransientDatabaseError(drizzleWrapper(pgError("Connection terminated unexpectedly")))).toBe(true);
  });

  it("retries pool acquire timeouts and network resets", () => {
    expect(isTransientDatabaseError(drizzleWrapper(pgError("timeout exceeded when trying to connect")))).toBe(true);
    expect(isTransientDatabaseError(drizzleWrapper(pgError("read ECONNRESET", "ECONNRESET")))).toBe(true);
    expect(isTransientDatabaseError(drizzleWrapper(pgError("terminating connection due to administrator command", "57P01")))).toBe(true);
    expect(isTransientDatabaseError(drizzleWrapper(pgError("deadlock detected", "40P01")))).toBe(true);
  });

  it("retries a bare Drizzle wrapper with no reported reason", () => {
    expect(isTransientDatabaseError(drizzleWrapper())).toBe(true);
  });

  it("does not retry request errors such as constraint or missing column", () => {
    expect(isTransientDatabaseError(drizzleWrapper(pgError("duplicate key value", "23505")))).toBe(false);
    expect(isTransientDatabaseError(drizzleWrapper(pgError('column "x" does not exist', "42703")))).toBe(false);
    expect(isTransientDatabaseError(drizzleWrapper(pgError("invalid input syntax", "22P02")))).toBe(false);
  });

  it("does not treat ordinary application errors as database failures", () => {
    expect(isTransientDatabaseError(new Error("Source-owned invoice continuation refused"))).toBe(false);
  });

  it("records the underlying reason alongside a shortened query", () => {
    const text = describeErrorWithCause(drizzleWrapper(pgError("Connection terminated due to connection timeout")));
    expect(text).toContain("Connection terminated due to connection timeout");
    expect(text).not.toContain("params: 149");
    expect(describeErrorWithCause(drizzleWrapper())).toContain("no underlying database reason");
  });
});
