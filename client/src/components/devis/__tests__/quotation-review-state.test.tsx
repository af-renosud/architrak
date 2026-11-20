// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { setQuotationWork, settleSavedContextWork, useQuotationWork } from "../quotation-review-state";

it("does not refresh the approval checklist when idle editors mount or repeat unchanged status", () => {
  const { result } = renderHook(() => useQuotationWork(98231));
  const start = result.current.epoch;
  act(() => setQuotationWork(98231, "context-upload:inline:1", false));
  expect(result.current.epoch).toBe(start);
  act(() => setQuotationWork(98231, "context:inline:1", true, "Saving", "document"));
  const saving = result.current.epoch;
  act(() => setQuotationWork(98231, "context:inline:1", true, "Saving", "document"));
  expect(result.current.epoch).toBe(saving);
  act(() => setQuotationWork(98231, "context:inline:1", false));
  expect(result.current.blocked).toBe(false);
});

it("settles exact persisted context only, preserving newer drafts and uploads", () => {
  const { result } = renderHook(() => useQuotationWork(98232));
  act(() => {
    setQuotationWork(98232, "context:inline:1", true, "Failed", "same");
    setQuotationWork(98232, "context:workspace:1", true, "Unsaved", "newer");
    setQuotationWork(98232, "context-debounce:inline:1", true, "Typing", "same");
    setQuotationWork(98232, "image-request:inline:1:x", true, "Uploading", "same");
    settleSavedContextWork(98232, 1, "same");
  });
  expect(result.current.issues.map(i => i.key)).toEqual([
    "context:workspace:1", "context-debounce:inline:1", "image-request:inline:1:x",
  ]);
});
