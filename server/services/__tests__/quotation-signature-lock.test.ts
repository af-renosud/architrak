import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  query: vi.fn(), release: vi.fn(), connect: vi.fn(),
}));
vi.mock("../../db", () => ({ db: {}, pool: { connect: fixture.connect } }));
import { withQuotationSignatureLock } from "../quotation-signature-lock";
beforeEach(() => {
  vi.resetAllMocks();
  fixture.connect.mockResolvedValue({ query: fixture.query, release: fixture.release });
  fixture.query.mockResolvedValue({ rows: [{ acquired: true }] });
});
it("holds the signature lock until the handler finishes and releases on error", async () => {
  const next = vi.fn();
  const handler = vi.fn(async () => {
    expect(fixture.release).not.toHaveBeenCalled();
    throw new Error("upstream failed");
  });
  await withQuotationSignatureLock(handler)({ params: { id: "123" } } as any, {} as any, next);
  expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "upstream failed" }));
  expect(fixture.query.mock.calls[1][0]).toContain("pg_advisory_unlock");
  expect(fixture.release).toHaveBeenCalledWith(false);
});
it("does not send while replacement owns the lock", async () => {
  fixture.query.mockResolvedValue({ rows: [{ acquired: false }] });
  const handler = vi.fn(), json = vi.fn(), status = vi.fn(() => ({ json }));
  await withQuotationSignatureLock(handler)({ params: { id: "123" } } as any, { status } as any, vi.fn());
  expect(status).toHaveBeenCalledWith(409);
  expect(handler).not.toHaveBeenCalled();
  expect(fixture.release).toHaveBeenCalledWith(false);
});
it("destroys a connection if unlocking fails rather than returning a locked session to the pool", async () => {
  fixture.query.mockResolvedValueOnce({ rows: [{ acquired: true }] }).mockRejectedValueOnce(new Error("connection lost"));
  await withQuotationSignatureLock(vi.fn())({ params: { id: "123" } } as any, {} as any, vi.fn());
  expect(fixture.release).toHaveBeenCalledWith(true);
});
