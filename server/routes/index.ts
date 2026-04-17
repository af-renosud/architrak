import type { Express } from "express";
import { createServer, type Server } from "http";
import { rateLimit } from "../middleware/rate-limit";

import projectsRouter from "./projects";
import contractorsRouter from "./contractors";
import marchesRouter from "./marches";
import lotsRouter from "./lots";
import devisRouter from "./devis";
import invoicesRouter from "./invoices";
import situationsRouter from "./situations";
import certificatsRouter from "./certificats";
import feesRouter from "./fees";
import financialRouter from "./financial";
import dashboardRouter from "./dashboard";
import archidocRouter from "./archidoc";
import gmailRouter from "./gmail";
import documentsRouter from "./documents";
import communicationsRouter from "./communications";
import settingsRouter from "./settings";
import webhooksRouter from "./webhooks";
import exportRouter from "./export";
import benchmarksRouter from "./benchmarks";

// Rate limiters: webhook is unauthenticated and takes external traffic, uploads
// hit AI extraction which is expensive, and the general API limiter is a
// belt-and-braces guard against runaway clients.
const webhookLimiter = rateLimit({ windowMs: 60_000, max: 60, message: "Webhook rate limit exceeded" });
const uploadLimiter = rateLimit({ windowMs: 60_000, max: 20, message: "Upload rate limit exceeded" });
const apiLimiter = rateLimit({ windowMs: 60_000, max: 600, message: "API rate limit exceeded" });

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.use("/api/webhooks", webhookLimiter);
  app.use(["/api/devis/:devisId/invoices/upload", "/api/projects/:projectId/devis/upload"], uploadLimiter);
  app.use("/api", apiLimiter);

  app.use(projectsRouter);
  app.use(contractorsRouter);
  app.use(marchesRouter);
  app.use(lotsRouter);
  app.use(devisRouter);
  app.use(invoicesRouter);
  app.use(situationsRouter);
  app.use(certificatsRouter);
  app.use(feesRouter);
  app.use(financialRouter);
  app.use(dashboardRouter);
  app.use(archidocRouter);
  app.use(gmailRouter);
  app.use(documentsRouter);
  app.use(communicationsRouter);
  app.use(settingsRouter);
  app.use(webhooksRouter);
  app.use(exportRouter);
  app.use(benchmarksRouter);

  return httpServer;
}
