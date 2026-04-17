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
import { seedBenchmarkTags } from "./services/benchmark-ingest.service";
import { SEED_BENCHMARK_TAGS } from "./services/benchmark-tags";
import { registerAuthRoutes } from "./auth/routes";
import { requireAuth } from "./auth/middleware";
import { pool } from "./db";
import { env } from "./env";
import { errorHandler } from "./middleware/error-handler";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

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
      maxAge: 7 * 24 * 60 * 60 * 1000,
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
  registerAuthRoutes(app);

  app.use("/api", (req, res, next) => {
    const publicPaths = ["/auth/login", "/auth/callback", "/auth/logout", "/auth/user", "/webhooks/archidoc"];
    if (publicPaths.includes(req.path)) {
      return next();
    }
    return requireAuth(req, res, next);
  });

  registerObjectStorageRoutes(app);
  await registerRoutes(httpServer, app);

  if (env.ARCHIDOC_POLLING_ENABLED) {
    startPolling(15 * 60 * 1000);
    console.log("[ArchiDoc] Polling mode active (ARCHIDOC_POLLING_ENABLED=true)");
  } else {
    console.log("[ArchiDoc] Webhook mode active, polling disabled. Set ARCHIDOC_POLLING_ENABLED=true to re-enable polling.");
  }
  startScheduler(60 * 60 * 1000);

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
})();
