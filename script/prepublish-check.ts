/**
 * Pre-publish check (Task #483).
 *
 * Runs the known publish blockers locally in one command so failures are
 * caught in ~a minute instead of after a failed deployment build:
 *
 *   1. Dependency audit  — `npm audit` must report 0 critical/high
 *      vulnerabilities (the deployment security scan blocks on these;
 *      it blocked the 2026-08-15 publish).
 *   2. Type check        — `tsc`.
 *   3. Unit / convention tests — `npx vitest run --no-file-parallelism`.
 *      Serialised because several integration tests share the dev database
 *      and fail under Vitest's default cross-file parallelism. Includes the
 *      project-scoped query-key enforcement test that blocks bare numeric
 *      project ids in TanStack Query keys.
 *   4. Production build  — `npm run build` (includes schema-drift and
 *      applied-migrations drift checks, vite client build, esbuild
 *      server bundle, server-assets copy).
 *   5. Smoke boot        — briefly boot `dist/index.cjs` (the real
 *      production bundle, NODE_ENV baked to "production") and wait for
 *      GET /healthz to answer 200. Catches bundle-only crashes such as
 *      ESM-only deps left external ("(0 , X.default) is not a function").
 *
 * Safety for the smoke boot: it runs against the DEV database with
 * RUN_MIGRATIONS_ON_START=false (no writes at boot beyond what any dev
 * boot does), GMAIL_POLLING_ENABLED=false (no inbox scanning) and
 * E2E_FAKE_GMAIL=true (any scheduler that would email logs instead).
 * It must never be pointed at PROD_DATABASE_URL.
 */
import { spawn, spawnSync } from "child_process";
import http from "http";

// Smoke-boot bounds. Side-effect safety comes from SMOKE_BOOT mode in the
// server (all background workers skipped), NOT from timing; these bounds
// just keep the gate fast and the child from lingering.
const SMOKE_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 8_000;

type GateResult = { name: string; ok: boolean; detail?: string };
const results: GateResult[] = [];

function heading(msg: string) {
  console.log(`\n\x1b[1m==> ${msg}\x1b[0m`);
}

function summarizeAndExit(): never {
  console.log("\n" + "=".repeat(60));
  let failed = false;
  for (const r of results) {
    const mark = r.ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`  ${mark}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    if (!r.ok) failed = true;
  }
  console.log("=".repeat(60));
  if (failed) {
    console.error("\n\x1b[31m✗ NOT ready to publish — fix the failures above first.\x1b[0m");
    process.exit(1);
  }
  console.log("\n\x1b[32m✓ All checks passed — ready to publish.\x1b[0m");
  process.exit(0);
}

function runStreaming(name: string, cmd: string, args: string[]): boolean {
  heading(name);
  const res = spawnSync(cmd, args, { stdio: "inherit", env: process.env });
  const ok = res.status === 0 && !res.error;
  results.push({
    name,
    ok,
    detail: ok ? undefined : res.error ? String(res.error) : `exit code ${res.status}`,
  });
  return ok;
}

function checkAudit(): boolean {
  heading("Dependency audit (blocks publish on critical/high)");
  const res = spawnSync("npm", ["audit", "--json"], {
    encoding: "utf-8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  // npm audit exits non-zero whenever ANY vulnerability exists, so parse
  // the JSON instead of trusting the exit code.
  let meta: { critical?: number; high?: number; moderate?: number; low?: number; total?: number };
  try {
    meta = JSON.parse(res.stdout).metadata.vulnerabilities;
  } catch {
    results.push({ name: "Dependency audit", ok: false, detail: "could not parse `npm audit --json` output" });
    console.error(res.stderr || res.stdout);
    return false;
  }
  const blocking = (meta.critical ?? 0) + (meta.high ?? 0);
  console.log(
    `vulnerabilities: critical=${meta.critical ?? 0} high=${meta.high ?? 0} moderate=${meta.moderate ?? 0} low=${meta.low ?? 0}`,
  );
  if (blocking > 0) {
    console.error(
      `\n${blocking} critical/high vulnerabilities — the deployment security scan will block the publish.` +
        `\nRun \`npm audit\` for details and \`npm audit fix\` to apply non-breaking fixes.`,
    );
    results.push({ name: "Dependency audit", ok: false, detail: `${blocking} critical/high vulnerabilities` });
    return false;
  }
  if ((meta.moderate ?? 0) + (meta.low ?? 0) > 0) {
    console.log("(moderate/low advisories present — these do not block publishing)");
  }
  results.push({ name: "Dependency audit", ok: true });
  return true;
}

function probeHealthz(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Compare two Postgres URLs by host + database name (ignores credentials,
 * encoding and query params so trivially-different spellings still match). */
function sameDatabase(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.hostname === ub.hostname && ua.pathname.replace(/\/+$/, "") === ub.pathname.replace(/\/+$/, "");
  } catch {
    // Unparseable URL — fail closed by treating them as the same.
    return true;
  }
}

async function smokeBoot(): Promise<boolean> {
  // --- Database guard: fail closed. ---
  const dbUrl = process.env.DATABASE_URL;
  const prodUrl = process.env.PROD_DATABASE_URL;
  if (!dbUrl) {
    results.push({ name: "Smoke boot", ok: false, detail: "DATABASE_URL is not set — refusing to smoke-boot" });
    return false;
  }
  if (prodUrl && sameDatabase(dbUrl, prodUrl)) {
    results.push({ name: "Smoke boot", ok: false, detail: "refusing to smoke-boot against the production database" });
    return false;
  }

  // --- Port: random ephemeral, preflighted so a stale listener can't
  // answer /healthz and produce a false pass. ---
  let port = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = 20000 + Math.floor(Math.random() * 20000);
    if ((await probeHealthz(candidate)) === null) {
      port = candidate;
      break;
    }
  }
  if (!port) {
    results.push({ name: "Smoke boot", ok: false, detail: "could not find a free port for the smoke boot" });
    return false;
  }
  heading(`Smoke boot of dist/index.cjs (production bundle, SMOKE_BOOT mode, port ${port})`);

  const smokeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // NODE_ENV is baked to "production" in the bundle via esbuild define;
    // set it here too for anything reading process.env directly.
    NODE_ENV: "production",
    PORT: String(port),
    // SMOKE_BOOT=true makes server boot skip ALL background workers,
    // boot-time reconciliation and seeding (see server/index.ts). This —
    // not timing — is what guarantees no emails / external syncs / boot
    // writes. RUN_MIGRATIONS_ON_START=false keeps schema untouched.
    SMOKE_BOOT: "true",
    RUN_MIGRATIONS_ON_START: "false",
    GMAIL_POLLING_ENABLED: "false",
  };
  // E2E_FAKE_GMAIL is forbidden in production-mode boots (env guard).
  delete smokeEnv.E2E_FAKE_GMAIL;
  // Never let the watchdog page anyone from a local smoke boot, and keep
  // dev-login off in a production-mode boot. Delete (not blank) — the env
  // schema rejects empty strings for optional keys.
  delete smokeEnv.OPERATOR_ALERT_EMAIL;
  delete smokeEnv.ENABLE_DEV_LOGIN_FOR_E2E;

  // Independent watchdog: `timeout` outlives this script, so even if the
  // prepublish process is killed mid-run the child cannot linger — it gets
  // SIGTERM at 60s and SIGKILL 5s later.
  const child = spawn("timeout", ["-k", "5", "60", "node", "dist/index.cjs"], {
    env: smokeEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const killChild = () => {
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
  };
  process.on("SIGINT", killChild);
  process.on("SIGTERM", killChild);
  process.on("exit", killChild);

  let output = "";
  child.stdout.on("data", (d) => {
    output += d;
    process.stdout.write(d);
  });
  child.stderr.on("data", (d) => {
    output += d;
    process.stderr.write(d);
  });

  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
  let ok = false;
  let detail: string | undefined;
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  while (Date.now() < deadline) {
    if (exited) {
      detail = `process exited early (code ${child.exitCode})`;
      break;
    }
    const status = await probeHealthz(port);
    if (status === 200 && !exited) {
      // The preflight guaranteed nothing else was listening here, and the
      // child is still alive — the responder is our child.
      ok = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ok && !detail) detail = `no 200 from /healthz within ${SMOKE_TIMEOUT_MS / 1000}s`;

  if (!exited) {
    // GNU timeout forwards TERM to the node process it manages.
    child.kill("SIGTERM");
    const cleanExit = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(false);
      }, KILL_GRACE_MS);
      child.on("exit", (code) => {
        clearTimeout(t);
        resolve(code === 0);
      });
    });
    if (ok && !cleanExit) {
      ok = false;
      detail = "server answered /healthz but did not shut down cleanly on SIGTERM";
    }
  }
  process.removeListener("SIGINT", killChild);
  process.removeListener("SIGTERM", killChild);
  process.removeListener("exit", killChild);

  if (ok) {
    console.log("\nSmoke boot OK — production bundle served /healthz 200 and shut down cleanly.");
  } else {
    console.error(`\nSmoke boot FAILED — ${detail}`);
    if (/is not a function/.test(output)) {
      console.error(
        "Hint: '(0 , X.default) is not a function' usually means an ESM-only dependency " +
          "was left external to the CJS bundle — add it to the allowlist in script/build.ts.",
      );
    }
  }
  results.push({ name: "Smoke boot", ok, detail: ok ? undefined : detail });
  return ok;
}

(async () => {
  const gates: Array<() => boolean | Promise<boolean>> = [
    checkAudit,
    () => runStreaming("Bare currency check", "bash", ["scripts/check-bare-currency.sh"]),
    () => runStreaming("Type check (tsc)", "npx", ["tsc"]),
    () => runStreaming("Unit / convention tests (vitest)", "npx", ["vitest", "run", "--no-file-parallelism"]),
    () => runStreaming("Production build (npm run build)", "npm", ["run", "build"]),
    smokeBoot,
  ];
  for (const gate of gates) {
    const ok = await gate();
    if (!ok) break; // later gates depend on earlier ones; stop at first failure
  }
  // Record skipped gates so the summary is honest about what did not run.
  const names = [
    "Dependency audit",
    "Bare currency check",
    "Type check (tsc)",
    "Unit / convention tests (vitest)",
    "Production build (npm run build)",
    "Smoke boot",
  ];
  for (const n of names) {
    if (!results.find((r) => r.name === n)) {
      results.push({ name: n, ok: false, detail: "skipped (earlier gate failed)" });
    }
  }
  summarizeAndExit();
})();
