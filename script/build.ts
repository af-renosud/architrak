import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";
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
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
