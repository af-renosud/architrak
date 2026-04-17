import type { ErrorRequestHandler, Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { env } from "../env";

/**
 * Global Express error handler.
 *
 * Sits at the very end of the middleware chain. Express 5 forwards
 * unhandled rejections from async route handlers here, so this is the
 * single chokepoint where ALL backend errors are formatted before they
 * leave the server.
 *
 * Behavior:
 *  - Always logs the full error (with request id when present) to
 *    `console.error` for internal tracing.
 *  - `ZodError` ⇒ 400 with a flat array of `{ path, message }` issues.
 *  - Errors carrying an explicit `status`/`statusCode` ⇒ that status
 *    plus a redacted JSON body.
 *  - Anything else ⇒ 500 with a stable, opaque payload in production
 *    and a stack trace in development.
 *
 * The handler NEVER leaks raw error messages, stack traces, or driver
 * payloads (DB constraint strings, third-party API bodies) to the
 * client in production.
 */

interface ErrorBody {
  error: string;
  code: string;
  requestId?: string;
  issues?: Array<{ path: string; message: string }>;
  stack?: string;
  detail?: string;
}

const isZodError = (err: unknown): err is ZodError => err instanceof ZodError;

const hasNumericStatus = (err: unknown): err is { status?: number; statusCode?: number } =>
  typeof err === "object" && err !== null && ("status" in err || "statusCode" in err);

const extractStatus = (err: unknown): number | undefined => {
  if (!hasNumericStatus(err)) return undefined;
  const raw = (err as { status?: unknown; statusCode?: unknown }).status
    ?? (err as { status?: unknown; statusCode?: unknown }).statusCode;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 400 && raw <= 599) {
    return raw;
  }
  return undefined;
};

const safeMessage = (err: unknown): string => {
  if (err instanceof Error && typeof err.message === "string") return err.message;
  if (typeof err === "string") return err;
  return "Internal Server Error";
};

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // Always log internally, regardless of what we send to the client.
  const ridSuffix = req.requestId ? ` rid=${req.requestId}` : "";
  if (err instanceof Error) {
    console.error(`[error-handler]${ridSuffix} ${err.name}: ${err.message}`);
    if (err.stack) console.error(err.stack);
  } else {
    console.error(`[error-handler]${ridSuffix} non-Error thrown:`, err);
  }

  // If headers were already sent (e.g. SSE stream), defer to Express's
  // default handler which will close the connection.
  if (res.headersSent) {
    next(err);
    return;
  }

  const isProd = env.NODE_ENV === "production";
  const baseBody: ErrorBody = {
    error: "Internal Server Error",
    code: "INTERNAL_ERROR",
    ...(req.requestId ? { requestId: req.requestId } : {}),
  };

  // --- Zod validation errors ------------------------------------------
  if (isZodError(err)) {
    const issues = err.issues.map((issue) => ({
      path: issue.path.map((p) => String(p)).join("."),
      message: issue.message,
    }));
    res.status(400).json({
      ...baseBody,
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      issues,
    });
    return;
  }

  // --- Errors with an explicit HTTP status -----------------------------
  const explicitStatus = extractStatus(err);
  if (explicitStatus !== undefined) {
    // 4xx client errors are safe to surface a sanitized message.
    if (explicitStatus < 500) {
      res.status(explicitStatus).json({
        ...baseBody,
        error: safeMessage(err),
        code: "CLIENT_ERROR",
      });
      return;
    }
    // 5xx with explicit status: still mask details in production.
    res.status(explicitStatus).json({
      ...baseBody,
      ...(isProd
        ? {}
        : { detail: safeMessage(err), stack: err instanceof Error ? err.stack : undefined }),
    });
    return;
  }

  // --- Unhandled / unknown errors -------------------------------------
  res.status(500).json({
    ...baseBody,
    ...(isProd
      ? {}
      : {
          detail: safeMessage(err),
          stack: err instanceof Error ? err.stack : undefined,
        }),
  });
};
