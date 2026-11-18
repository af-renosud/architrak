import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, cp, access } from "fs/promises";
import { spawnSync } from "child_process";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  // ESM-only: must be bundled — leaving it external makes the CJS bundle
  // require() it and esbuild's __toESM interop yields a non-callable
  // `.default` at runtime ("(0 , x.default) is not a function").
  "p-limit",
  "passport",
  "passport-local",
  "pg",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

function checkSchemaDrift() {
  console.log("checking schema/migrations drift...");
  const result = spawnSync("bash", ["scripts/check-schema-drift.sh"], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error("Failed to run scripts/check-schema-drift.sh:", result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `Schema drift check failed (exit code ${result.status}). Aborting build.`,
    );
    process.exit(result.status ?? 1);
  }
}

function checkMigrationDrift() {
  console.log("checking applied-migrations drift against target database...");
  const result = spawnSync(
    "npx",
    ["tsx", "scripts/check-migration-drift.mjs"],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.error) {
    console.error(
      "Failed to run scripts/check-migration-drift.mjs:",
      result.error,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `Migration drift check failed (exit code ${result.status}). Aborting build.`,
    );
    process.exit(result.status ?? 1);
  }
}

async function buildAll() {
  checkSchemaDrift();
  checkMigrationDrift();

  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  const serverBuild = await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
    metafile: true,
  });

  // Trace external packages too: absence from bundled inputs alone is not proof
  // of absence from the production dependency graph.
  const { createRequire } = await import("node:module");
  const { join, dirname } = await import("node:path");
  const visited = new Set<string>();
  const forbidden = new Set(["picomatch", "tinyglobby", "fdir", "vite", "vitest"]);
  async function checkRuntimePackage(name: string, from: string) {
    const packageName = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
    if (forbidden.has(packageName)) throw new Error(`Unsafe production dependency: ${packageName}`);
    if (name.startsWith("node:") || (await import("node:module")).builtinModules.includes(name)) return;
    // Read manifests through Node's package search paths, independently of
    // package exports (some dependencies are ESM-only or hide package.json).
    const localRequire = createRequire(join(from, "__runtime_check.cjs"));
    let path: string | undefined;
    for (const directory of localRequire.resolve.paths(packageName) || []) {
      const candidate = join(directory, packageName, "package.json");
      try { await access(candidate); path = candidate; break; }
      catch (error: any) { if (error.code !== "ENOENT") throw error; }
    }
    if (!path) {
      // An absent optional module cannot carry this dependency. Smoke boot
      // separately verifies that the production server starts successfully.
      console.log(`Runtime dependency inspection: ${name} not installed.`);
      return;
    }
    if (visited.has(path)) return;
    visited.add(path);
    const pkg = JSON.parse(await readFile(path, "utf8"));
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
      await checkRuntimePackage(dep, dirname(path));
    }
  }
  for (const input of Object.keys(serverBuild.metafile.inputs)) {
    if (/node_modules\/(picomatch|tinyglobby|fdir|vite|vitest)\//.test(input)) {
      throw new Error(`Unsafe production bundle input: ${input}`);
    }
  }
  for (const output of Object.values(serverBuild.metafile.outputs)) {
    for (const imp of output.imports) {
      if (imp.external) await checkRuntimePackage(imp.path, process.cwd());
    }
  }
  console.log("Production dependency check passed: affected build/test packages are not in the server runtime graph.");

  // Task #443 — bundled email attachments (server/assets) must ship with
  // the compiled output: the runtime resolver checks dist/assets first via
  // __dirname, so a deployment rooted at dist still finds them. A missing
  // required asset fails the whole email send at runtime, so fail the
  // BUILD instead if the copy didn't produce the explainer PDF.
  console.log("copying server assets...");
  await cp("server/assets", "dist/assets", { recursive: true });
  await access("dist/assets/how-signing-and-payment-works.pdf");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
