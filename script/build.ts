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

  await esbuild({
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
  });

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
