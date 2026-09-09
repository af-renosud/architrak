import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  manualCertificatPreviewKey,
  manualCertificatPreviewQueryOptions,
} from "../manual-certificat-preview";

describe("manual certificate preview freshness", () => {
  it("refetches unchanged form inputs after reopen and stays non-submittable while refreshing", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    let autoliquidation = false;
    let calls = 0;
    let releaseRefresh: (() => void) | undefined;
    const queryFn = vi.fn(async () => {
      calls += 1;
      if (calls === 2) {
        await new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
      }
      return {
        tva: {
          ratePercent: autoliquidation ? "0.00" : "20.00",
          autoliquidation,
        },
      };
    });
    const queryKey = manualCertificatPreviewKey(
      42,
      7,
      9,
      "1000.00",
      "ht",
    );
    const options = (enabled: boolean) => ({
      queryKey,
      queryFn,
      enabled,
      ...manualCertificatPreviewQueryOptions,
    });
    const observer = new QueryObserver(client, options(false));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      observer.setOptions(options(true));
      await vi.waitFor(() => {
        expect(observer.getCurrentResult().data?.tva.ratePercent).toBe("20.00");
      });

      observer.setOptions(options(false));
      autoliquidation = true;
      observer.setOptions(options(true));
      await vi.waitFor(() => {
        expect(queryFn).toHaveBeenCalledTimes(2);
      });
      expect(observer.getCurrentResult().isFetching).toBe(true);
      expect(
        observer.getCurrentResult().isFetching ||
          !observer.getCurrentResult().data,
      ).toBe(true);

      releaseRefresh?.();
      await vi.waitFor(() => {
        expect(observer.getCurrentResult().data?.tva).toEqual({
          ratePercent: "0.00",
          autoliquidation: true,
        });
      });
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("nests previews under the canonical project certificate key", () => {
    expect(manualCertificatPreviewKey(42, 7, "1000.00")).toEqual([
      "/api/projects",
      "42",
      "certificats",
      "manual-preview",
      7,
      "1000.00",
    ]);
  });
});