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
