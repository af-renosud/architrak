import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type LockedPackage = { version?: string };
type Lockfile = { packages: Record<string, LockedPackage> };

const locks = ["package-lock.json", "artifacts/mockup-sandbox/package-lock.json"].map(
  (path) => ({
    path,
    lock: JSON.parse(readFileSync(resolve(path), "utf8")) as Lockfile,
  }),
);

function atLeast(version: string, minimum: string): boolean {
  const actual = version.split(".").map(Number);
  const required = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}

// Check every nested occurrence, not just the top-level/deduped dependency.
// Older unaffected esbuild and selector-parser branches remain supported.
const rules: Record<string, (version: string) => boolean> = {
  postcss: (v) => atLeast(v, "8.5.23"),
  browserslist: (v) => atLeast(v, "4.28.7"),
  nanoid: (v) => v.startsWith("3.") ? atLeast(v, "3.3.18") : atLeast(v, "5.1.16"),
  multer: (v) => atLeast(v, "2.4.0"),
  qs: (v) => atLeast(v, "6.16.0"),
  vitest: (v) => atLeast(v, "4.1.11"),
  "@vitest/mocker": (v) => atLeast(v, "4.1.11"),
  "baseline-browser-mapping": (v) => atLeast(v, "2.11.0"),
  "postcss-selector-parser": (v) =>
    (!atLeast(v, "6.1.0") || atLeast(v, "6.1.3")) &&
    (!atLeast(v, "7.1.0") || atLeast(v, "7.1.3")),
  "@babel/core": (v) => atLeast(v, "7.29.6"),
  esbuild: (v) => !atLeast(v, "0.27.3") || atLeast(v, "0.28.1"),
};

describe("dependency security in application and sandbox lockfiles", () => {
  for (const [name, isSafe] of Object.entries(rules)) {
    it(`${name} is outside the reported vulnerable ranges`, () => {
      const occurrences = locks.flatMap(({ path, lock }) =>
        Object.entries(lock.packages)
          .filter(([entry]) => entry.endsWith(`node_modules/${name}`))
          .map(([entry, pkg]) => ({ path, entry, version: pkg.version! })),
      );
      expect(occurrences.length).toBeGreaterThan(0);
      for (const { path, entry, version } of occurrences) {
        expect(isSafe(version), `${path}: ${entry}@${version}`).toBe(true);
      }
    });
  }
});