export function isUnauthorizedError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.startsWith("401");
  }
  return false;
}
