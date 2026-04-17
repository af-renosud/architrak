import type { Request } from "express";

export interface Pagination {
  limit: number;
  offset: number;
}

export interface PaginationOptions {
  defaultLimit?: number;
  maxLimit?: number;
}

export function parsePagination(req: Request, opts: PaginationOptions = {}): Pagination {
  const { defaultLimit = 50, maxLimit = 200 } = opts;
  const rawLimit = Number(req.query.limit);
  const rawOffset = Number(req.query.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), maxLimit)
    : defaultLimit;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
  return { limit, offset };
}

export function paged<T>(items: T[], pagination: Pagination, total?: number) {
  return {
    items,
    pagination: {
      limit: pagination.limit,
      offset: pagination.offset,
      total: total ?? items.length,
      hasMore: items.length === pagination.limit,
    },
  };
}
