import { afterEach, expect, it, vi } from "vitest";
const config = vi.hoisted(() => ({
  ARCHIDOC_BASE_URL: "https://archiouvro.com",
  ARCHIDOC_SYNC_API_KEY: "test-current",
  ARCHIDOC_SYNC_API_KEY_NEXT: "test-next" as string | undefined,
}));
vi.mock("../../env", () => ({env:config}));
import { prepareSupplierDirectorySnapshot, fetchContractors, selectedSyncCredentialName, probeArchiDocSyncAuthentication } from "../sync-client";
afterEach(() => { vi.unstubAllGlobals(); config.ARCHIDOC_SYNC_API_KEY_NEXT = "test-next"; });
it("never requests the browser-session supplier endpoint", async () => {
  const request = vi.fn().mockResolvedValue(new Response("{}",{status:401})); vi.stubGlobal("fetch", request);
  await expect(prepareSupplierDirectorySnapshot()).rejects.toThrow("unauthorized");
  expect(request).toHaveBeenCalledTimes(1);
  expect(new URL(request.mock.calls[0][0]).pathname).toBe("/api/integrations/architrak/v1/supplier-directory");
});
it("uses the supported contractor feed with explicit NEXT precedence and no 401 fallback", async () => {
  const request = vi.fn().mockResolvedValue(new Response("{}", {status:401}));
  vi.stubGlobal("fetch", request);
  expect(selectedSyncCredentialName()).toBe("ARCHIDOC_SYNC_API_KEY_NEXT");
  await expect(fetchContractors()).rejects.toThrow("[/api/sync/contractors]");
  expect(request).toHaveBeenCalledTimes(1);
  expect(String(request.mock.calls[0][0])).toContain("/api/sync/contractors");
  config.ARCHIDOC_SYNC_API_KEY_NEXT = undefined;
  expect(selectedSyncCredentialName()).toBe("ARCHIDOC_SYNC_API_KEY");
});
it("probes only once with redirects disabled and returns no credentials or body", async () => {
  const request = vi.fn().mockResolvedValue(new Response("sensitive body", {status:401,headers:{"content-type":"application/json"}}));
  vi.stubGlobal("fetch", request);
  expect(await probeArchiDocSyncAuthentication("ARCHIDOC_SYNC_API_KEY")).toEqual({
    credentialName:"ARCHIDOC_SYNC_API_KEY",status:401,responseType:"json",
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1].redirect).toBe("manual");
});
