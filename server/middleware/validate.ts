import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ZodTypeAny } from "zod";

export interface ValidateRequestSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

// Returns a plain `RequestHandler` (no custom Params/Body generics) so that
// chaining with other middleware (e.g. `upload.single`, `requireAuth`) does
// not provoke Express's overload resolver into reporting type-mismatches.
// Validation still mutates `req.body`/`req.query`/`req.params` at runtime
// using each schema's coerced output; handlers should narrow with explicit
// casts (e.g. `req.body as InsertX`) where strict typing is needed.
export function validateRequest(
  schemas: ValidateRequestSchemas,
): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) {
        req.body = await schemas.body.parseAsync(req.body);
      }
      if (schemas.query) {
        const parsedQuery = await schemas.query.parseAsync(req.query);
        Object.defineProperty(req, "query", {
          value: parsedQuery,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
      if (schemas.params) {
        req.params = await schemas.params.parseAsync(req.params);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
