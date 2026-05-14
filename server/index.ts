import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { randomUUID } from "crypto";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { registerObjectStorageRoutes } from "./replit_integrations/object_storage";
import { startPolling } from "./gmail/monitor";
import { startScheduler } from "./communications/payment-scheduler";
import { startSignedPdfRetrySweeper } from "./services/devis-signed-pdf.service";
import { startOutstandingFeesDigestScheduler } from "./communications/outstanding-fees-digest";
import { startDevisCheckTokenCleanup } from "./services/devis-check-token-cleanup";
import { startContractorAutoSyncScheduler } from "./archidoc/contractor-auto-sync";
import { clearPreviousBackendMirrorRows } from "./archidoc/sync-service";
import { seedBenchmarkTags } from "./services/benchmark-ingest.service";
import { SEED_BENCHMARK_TAGS } from "./services/benchmark-tags";
import { registerAuthRoutes } from "./auth/routes";
import publicChecksRouter from "./routes/public-checks";
import publicClientChecksRouter from "./routes/public-client-checks";
import { requireAuth } from "./auth/middleware";
import { pool } from "./db";
import { env } from "./env";
import { errorHandler } from "./middleware/error-handler";
import { runMigrations } from "./migrate";
import { reportMigrationDrift } from "./migration-drift";
import { startHealthzWatchdog } from "./operations/healthz-watchdog";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Archisign webhook MUST be byte-exact for HMAC v2 verification (§3.9.1).
// The raw-body parser is mounted route-level inside
// `server/routes/archisign-webhooks.ts` (path `/api/webhooks/archisign`)
// so it is co-located with the verifier and cannot be silently bypassed
// by ordering changes here. The express.json `verify` callback below
// captures `req.rawBody` for any other webhook needing a verbatim copy.
const jsonParser = express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
});
app.use((req, res, next) => {
  // Skip the global JSON parser for the Archisign webhook path so the
  // route-level express.raw() in `server/routes/archisign-webhooks.ts`
  // can read the body bytes verbatim for HMAC v2 verification.
  if (req.path === "/api/webhooks/archisign") return next();
  return jsonParser(req, res, next);
});

app.use(express.urlencoded({ extended: false }));

app.set("trust proxy", 1);

const PgStore = connectPgSimple(session);
app.use(
  session({
    store: new PgStore({
      pool,
      tableName: "session",
      createTableIfMissing: false,
    }),
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
    },
  }),
);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

declare module "express-serve-static-core" {
  interface Request {
    requestId?: string;
  }
}

app.use((req, res, next) => {
  const incoming = req.header("x-request-id");
  const requestId = incoming && /^[A-Za-z0-9-]{8,128}$/.test(incoming) ? incoming : randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (!path.startsWith("/api")) return;
    // Redacted log line: never include response body. Bodies may contain
    // financial data, extracted email content, or PII (FR accounting docs).
    const userId = (req as any).session?.userId ? `u=${(req as any).session.userId} ` : "";
    log(`${req.method} ${path} ${res.statusCode} ${duration}ms rid=${req.requestId} ${userId}`.trim());
  });

  next();
});

(async () => {
  if (process.env.SKIP_MIGRATION_DRIFT_CHECK !== "true") {
    await reportMigrationDrift();
  }

  if (process.env.RUN_MIGRATIONS_ON_START !== "false") {
    try {
      await runMigrations();
    } catch (err) {
      console.error("[migrate] failed to apply migrations:", err);
      throw err;
    }
  }

  registerAuthRoutes(app);

  // Public contractor portal — token-protected, NOT under /api so it bypasses
  // the session auth guard below. Auth is enforced by the token lookup itself.
  app.use(publicChecksRouter);
  app.use(publicClientChecksRouter);

  app.use("/api", (req, res, next) => {
    const publicPaths = ["/auth/login", "/auth/callback", "/auth/logout", "/auth/user", "/webhooks/archidoc", "/webhooks/archisign"];
    // Public devis-PDF download (signed-token auth) — Archisign fetches
    // server-side from a different origin, so it cannot present a session
    // cookie. The token verifier is the auth wall.
    if (req.path.startsWith("/public/devis-pdf/")) {
      return next();
    }
    if (env.NODE_ENV !== "production" && env.ENABLE_DEV_LOGIN_FOR_E2E) {
      publicPaths.push("/auth/dev-login");
    }
    if (publicPaths.includes(req.path)) {
      return next();
    }
    return requireAuth(req, res, next);
  });

  registerObjectStorageRoutes(app);
  await registerRoutes(httpServer, app);

  // Task #198 — Drive auto-upload sweeper. No-op when feature flag is
  // off (safe to call unconditionally on every boot).
  try {
    const { startDriveUploadSweeper } = await import("./services/drive/upload-queue.service");
    startDriveUploadSweeper();
  } catch (err) {
    console.error("[DriveQueue] failed to start sweeper:", err);
  }

  // Boot-time backend-swap reconciliation (Task #164). MUST run
  // BEFORE the contractor-auto-sync scheduler and the webhook
  // listeners come online, otherwise a stale dev/legacy mirror row
  // could be re-imported into the canonical contractors table by the
  // first auto-sync tick — or surface in the New-Project dialog —
  // before the next hourly full sync re-stamps source_base_url.
  // Soft-skipped when ARCHIDOC_BASE_URL is unset (dev / CI).
  try {
    await clearPreviousBackendMirrorRows();
  } catch (err) {
    console.error("[ArchiDoc] Boot reconciliation failed (continuing):", err);
  }

  if (env.ARCHIDOC_POLLING_ENABLED) {
    startPolling(15 * 60 * 1000);
    console.log("[ArchiDoc] Polling mode active (ARCHIDOC_POLLING_ENABLED=true)");
  } else {
    console.log("[ArchiDoc] Webhook mode active, polling disabled. Set ARCHIDOC_POLLING_ENABLED=true to re-enable polling.");
  }
  startScheduler(60 * 60 * 1000);
  // Task #206 — durable retry queue for signed-PDF persistence
  // failures. The webhook handler always tries first (detached);
  // this sweeper picks up rows that failed and have a due
  // next_attempt_at, with exponential backoff up to 5 attempts.
  startSignedPdfRetrySweeper(5 * 60_000);
  startOutstandingFeesDigestScheduler(60 * 60 * 1000);
  startContractorAutoSyncScheduler(60 * 60 * 1000);
  startDevisCheckTokenCleanup(6 * 60 * 60 * 1000);

  // AT5 (Task #153): outbound webhook delivery sweeper. Drains
  // `webhook_deliveries_out` rows whose next_attempt_at is due. The
  // sweeper is idempotent and safe to start in dev — it will simply
  // find nothing to do when ARCHITRAK_WEBHOOK_SECRET is unset (the
  // enqueue path soft-skips, so no rows accumulate).
  const { startWebhookDeliverySweeper } = await import("./services/webhook-delivery");
  startWebhookDeliverySweeper();

  // Runtime watchdog (Task #126): poll /healthz/deep every 5 min and
  // alert on the OK→FAIL transition. Skipped unless we are in
  // production AND the operator-alert recipient list is configured —
  // dev / CI runs would just produce log noise. The watchdog fetches
  // its own port over loopback so it shares the readiness contract
  // with the platform's external probes.
  if (env.NODE_ENV === "production" && env.OPERATOR_ALERT_EMAIL) {
    startHealthzWatchdog({
      url: `http://127.0.0.1:${env.PORT}/healthz/deep`,
      intervalMs: 5 * 60 * 1000,
    });
    console.log("[healthz-watchdog] started (5min interval)");
  }

  seedBenchmarkTags(SEED_BENCHMARK_TAGS).catch(err => {
    console.warn("[Benchmark] tag seed failed:", (err as Error).message);
  });

  app.use(errorHandler);

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = env.PORT;
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      console.warn(`[shutdown] ${signal} received again, ignoring`);
      return;
    }
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, closing HTTP server...`);

    const forceExitTimer = setTimeout(() => {
      console.error("[shutdown] Force exit after 10s timeout");
      process.exit(1);
    }, 10000);
    forceExitTimer.unref();

    httpServer.close((err) => {
      if (err) {
        console.error("[shutdown] HTTP server close error:", err);
      } else {
        console.log("[shutdown] HTTP server closed, draining pg pool...");
      }
      pool
        .end()
        .then(() => {
          console.log("[shutdown] pg pool drained, exiting cleanly");
          clearTimeout(forceExitTimer);
          process.exit(err ? 1 : 0);
        })
        .catch((poolErr) => {
          console.error("[shutdown] pg pool drain error:", poolErr);
          clearTimeout(forceExitTimer);
          process.exit(1);
        });
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
})();
