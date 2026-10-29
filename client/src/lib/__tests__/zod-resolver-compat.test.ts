import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

describe("Zod validation upgrade compatibility", () => {
  const schema = z.object({
    amount: z.string().min(1, "Amount is required"),
    status: z.enum(["draft", "ready"]).default("draft"),
  });
  const resolve = zodResolver(schema);
  const options = { fields: {}, shouldUseNativeValidation: false } as const;

  it("returns field errors instead of throwing on invalid form submissions", async () => {
    const result = await resolve({ amount: "" }, undefined, options);
    expect(result.errors).toMatchObject({ amount: { message: "Amount is required" } });
    expect(result.values).toEqual({});
  });

  it("preserves parsed defaults in valid submissions", async () => {
    const result = await resolve({ amount: "120.00" }, undefined, options);
    expect(result.errors).toEqual({});
    expect(result.values).toEqual({ amount: "120.00", status: "draft" });
  });
});
