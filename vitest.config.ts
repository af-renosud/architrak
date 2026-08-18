import { defineConfig } from "vitest/config";
import path from "path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "node",
    // The 5s default flakes under full-suite load (slow first-imports of
    // large module graphs + poppler/gs shell-outs routinely land right at
    // the ceiling on a busy machine). Individual tests can still override.
    testTimeout: 30_000,
    include: [
      "shared/__tests__/**/*.test.ts",
      "server/__tests__/**/*.test.ts",
      "server/**/__tests__/**/*.test.ts",
      "client/src/**/__tests__/**/*.test.ts",
      "client/src/**/__tests__/**/*.test.tsx",
      "scripts/__tests__/**/*.test.mjs",
      "scripts/__tests__/**/*.test.ts",
    ],
    exclude: ["node_modules", ".cache", "dist"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
});
