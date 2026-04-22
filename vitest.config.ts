import { defineConfig } from "vitest/config";
import path from "path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "node",
    include: [
      "shared/__tests__/**/*.test.ts",
      "server/__tests__/**/*.test.ts",
      "server/**/__tests__/**/*.test.ts",
      "client/src/**/__tests__/**/*.test.ts",
      "client/src/**/__tests__/**/*.test.tsx",
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
