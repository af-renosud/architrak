import { QueryClient, QueryFunction } from "@tanstack/react-query";

export class ApiError extends Error {
  readonly status: number;
  readonly data: unknown;
  readonly code?: string;
  constructor(status: number, message: string, data: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    if (data && typeof data === "object" && "code" in data && typeof (data as { code: unknown }).code === "string") {
      this.code = (data as { code: string }).code;
    }
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    let data: unknown = text;
    let message = `${res.status}: ${text}`;
    try {
      const parsed = JSON.parse(text);
      data = parsed;
      if (parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string") {
        message = (parsed as { message: string }).message;
      }
    } catch {
      // body wasn't JSON; leave defaults
    }
    throw new ApiError(res.status, message, data);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

/**
 * Task #508 — canonical query-key convention for project-scoped data.
 *
 * TanStack Query compares key segments strictly (9 !== "9"), and with
 * `staleTime: Infinity` a missed invalidation shows stale data until a full
 * page reload (the prod "No Certificat de Paiement" bug). The project id
 * segment of every `["/api/projects", id, ...]` key must therefore ALWAYS be
 * a string: build keys and invalidations with `String(projectId)` (route
 * params are already strings; DB-derived ids like `devis.projectId` are
 * numbers). Prefer this helper so keys and invalidations can't drift.
 */
export function projectScopedKey(
  projectId: string | number,
  ...rest: string[]
): (string | undefined)[] {
  return ["/api/projects", String(projectId), ...rest];
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
