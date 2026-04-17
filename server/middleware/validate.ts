import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import type { ParsedQs } from "qs";
import type { ZodTypeAny, infer as zInfer } from "zod";

export interface ValidateRequestSchemas<
  TBody extends ZodTypeAny | undefined = undefined,
  TQuery extends ZodTypeAny | undefined = undefined,
  TParams extends ZodTypeAny | undefined = undefined,
> {
  body?: TBody;
  query?: TQuery;
  params?: TParams;
}

type InferOr<T extends ZodTypeAny | undefined, Fallback> = T extends ZodTypeAny
  ? zInfer<T>
  : Fallback;

export function validateRequest<
  TBody extends ZodTypeAny | undefined = undefined,
  TQuery extends ZodTypeAny | undefined = undefined,
  TParams extends ZodTypeAny | undefined = undefined,
>(
  schemas: ValidateRequestSchemas<TBody, TQuery, TParams>,
): RequestHandler<
  InferOr<TParams, ParamsDictionary>,
  unknown,
  InferOr<TBody, unknown>,
  InferOr<TQuery, ParsedQs>
> {
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
