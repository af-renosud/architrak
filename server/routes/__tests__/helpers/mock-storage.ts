import { vi, type Mock } from "vitest";
import type { IStorage } from "../../../storage";

export type StorageMethod = keyof IStorage;

export type MockedStorage = { [K in StorageMethod]: Mock };

/**
 * Builds a Proxy-backed mock of the `storage` singleton for route unit tests.
 *
 * Methods listed in `mockedMethods` are plain `vi.fn()`s the test can
 * configure (`mockResolvedValue`, `mockImplementation`, …). Any OTHER
 * storage method accessed by the route under test still returns a
 * `vi.fn()` — but one whose implementation throws a descriptive error
 * naming the method. This makes drift fail loudly: when a route gains a
 * new storage call that the test file has not mocked, the failure says
 * exactly which method is missing instead of surfacing as a TypeError
 * ("storage.foo is not a function") translated into a generic 400.
 *
 * Usage inside a `vi.mock` factory (the factory must be async so it can
 * dynamically import this helper — static imports are not visible inside
 * hoisted factories):
 *
 *   vi.mock("../../storage", async () => {
 *     const { createStorageMock } = await import("./helpers/mock-storage");
 *     return { storage: createStorageMock(["getDevis", "updateDevis"]) };
 *   });
 *
 *   import { storage } from "../../storage";
 *   import { asStorageMock } from "./helpers/mock-storage";
 *   const storageMock = asStorageMock(storage);
 *   // storageMock.getDevis.mockResolvedValue(...)
 *
 * Notes:
 * - Mock functions are memoised per method name, so repeated property
 *   accesses return the SAME vi.fn (call assertions work as expected).
 * - `vi.clearAllMocks()` clears call history but keeps implementations,
 *   so both configured behaviour and the throwing guards survive the
 *   usual beforeEach reset.
 */
export function createStorageMock(
  mockedMethods: readonly StorageMethod[],
): MockedStorage {
  const fns = new Map<string, Mock>();
  const allowed = new Set<string>(mockedMethods);

  return new Proxy({} as MockedStorage, {
    get(_target, prop) {
      // Non-string keys and `then` must stay undefined so the proxy is
      // not mistaken for a thenable during dynamic import / await.
      if (typeof prop !== "string" || prop === "then") return undefined;
      let fn = fns.get(prop);
      if (!fn) {
        fn = allowed.has(prop)
          ? vi.fn()
          : vi.fn(() => {
              const message =
                `Unmocked storage method "${prop}" was called by the code under test. ` +
                `Add "${prop}" to the createStorageMock([...]) list in this test file ` +
                `and configure its behaviour.`;
              // Routes typically catch this and translate it into a 400,
              // and the failing assertion then only shows the status
              // mismatch — so ALSO print to stderr to make the missing
              // method name visible directly in the test output.
              console.error(`[mock-storage] ${message}`);
              throw new Error(message);
            });
        fns.set(prop, fn);
      }
      return fn;
    },
    has(_target, prop) {
      return typeof prop === "string" && prop !== "then";
    },
  });
}

/**
 * Re-types the mocked `storage` export (imported from the vi.mock'd
 * module) as its MockedStorage shape so tests can configure methods
 * without per-method casts.
 */
export function asStorageMock(storageExport: IStorage): MockedStorage {
  return storageExport as unknown as MockedStorage;
}
