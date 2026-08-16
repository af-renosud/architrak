/**
 * Enforcement test for the project-scoped query-key convention (Task #508 / #512).
 *
 * TanStack Query compares key segments with strict equality, and with
 * `staleTime: Infinity` a missed invalidation silently shows stale data until a
 * full page reload. The second element of every `["/api/projects", id, ...]` key
 * must therefore ALWAYS be a string — either a string literal, `String(x)`,
 * or a variable that was already converted with `String()`.
 *
 * This test scans every .ts / .tsx file under client/src and fails if it finds
 * a bare identifier used as the project-id segment, which would be a type mismatch
 * if the variable holds a numeric DB id.
 *
 * WHAT IS FLAGGED
 *   queryKey: ["/api/projects", projectId, ...]     ← bare identifier — could be number
 *   queryClient.invalidateQueries({ queryKey: ["/api/projects", devis.projectId, ...] })
 *
 * WHAT IS NOT FLAGGED
 *   queryKey: ["/api/projects", String(projectId), ...]   ← correct
 *   queryKey: ["/api/projects", "literal", ...]           ← string literal — fine
 *   queryKey: ["/api/projects", `template${x}`, ...]      ← template literal — fine
 *   queryKey: ["/api/projects"]                           ← list-level key — fine
 *   queryKey: ["/api/projects", { archived: ... }]        ← object filter — fine
 *   queryKey: ["/api/projects", x !== undefined ? String(x) : ""]  ← ternary, not a bare id
 *
 * FALSE POSITIVE ESCAPE HATCH
 *   If a variable is provably already a string (e.g. `const pidStr = String(pid)`)
 *   you can suppress a specific line with:
 *     // project-key-string-ok
 *   placed on the SAME line as the queryKey array.
 */

import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

function walkSync(dir: string, exts: string[], results: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip test directories — we only want production code.
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walkSync(full, exts, results);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Violation detector
// ---------------------------------------------------------------------------

/**
 * Returns violations of the form `{ file, line, text }`.
 *
 * A violation is a line that:
 *  1. Contains `"/api/projects",` or `'/api/projects',`
 *  2. The token immediately following the comma+whitespace is a bare JS
 *     identifier (or property access like `devis.projectId`) that ends with
 *     `,` or `]` — confirming it IS the segment value, not part of a larger
 *     expression (e.g. a ternary `id !== undefined ? String(id) : ""`).
 *  3. Is NOT inside a line comment (`//` or ` * ` JSDoc).
 *  4. Does NOT `String(` anywhere on the same line (belt-and-suspenders
 *     guard for multi-expression lines like ternaries).
 *  5. Does NOT have the `// project-key-string-ok` escape-hatch annotation.
 */
function findViolations(files: string[]): Array<{ file: string; line: number; text: string }> {
  // Matches: "/api/projects", OR '/api/projects',  followed by optional
  // whitespace, then a bare JS identifier (incl. dotted property access like
  // `devis.projectId`) that is immediately closed by optional-whitespace then
  // `,` or `]`.  The identifier must NOT start with `String(`, a quote/
  // backtick, `{`, `[`, `]`, `)`, or whitespace.
  const pattern =
    /["']\/api\/projects["'],\s*(?!String\()(?![`"'{[\])/\s])([A-Za-z_$][A-Za-z_$0-9.]*)(\s*[,\]])/g;

  const violations: Array<{ file: string; line: number; text: string }> = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip comment lines (JSDoc body lines and single-line comments).
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

      // Escape hatch: author confirms the variable is already a string.
      if (line.includes("project-key-string-ok")) continue;

      // If `String(` appears anywhere on the line the author is already
      // honoring the convention (e.g. in a ternary on the same line).
      if (line.includes("String(")) continue;

      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        violations.push({
          file: path.relative(process.cwd(), file),
          line: i + 1,
          text: trimmed,
        });
        // Only report each line once even if the pattern matches multiple times.
        break;
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("project-scoped query key convention", () => {
  it('every ["/api/projects", id, ...] key uses String(id) or a string literal for the id segment', () => {
    const clientSrcDir = path.resolve(__dirname, "../..");
    const files = walkSync(clientSrcDir, [".ts", ".tsx"]);

    const violations = findViolations(files);

    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file}:${v.line}\n    ${v.text}`)
        .join("\n");
      expect.fail(
        `Found ${violations.length} project-scoped query key(s) where the project id segment ` +
          `is not wrapped in String().\n\n` +
          `Fix: change \`["/api/projects", projectId, ...]\` ` +
          `to \`["/api/projects", String(projectId), ...]\`\n\n` +
          `Violations:\n${report}\n\n` +
          `If the variable is already a string, annotate the line with ` +
          `"// project-key-string-ok" to suppress.`,
      );
    }
  });
});
