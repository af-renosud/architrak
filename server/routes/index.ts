import type { Express } from "express";
import { createServer, type Server } from "http";
import { rateLimit } from "../middleware/rate-limit";

import projectsRouter from "./projects";
import contractorsRouter from "./contractors";
import marchesRouter from "./marches";
import lotsRouter from "./lots";
import lotCatalogRouter from "./lot-catalog";
import wishListRouter from "./wishlist";
import devisRouter from "./devis";
import devisChecksRouter from "./devis-checks";
import clientChecksRouter from "./client-checks";
import insuranceGateRouter from "./insurance-gate";
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
import archisignWebhooksRouter from "./archisign-webhooks";
import archisignEnvelopesRouter from "./archisign-envelopes";
import archisignPublicRouter from "./archisign-public";
import exportRouter from "./export";
import benchmarksRouter from "./benchmarks";
import adminDevisRematchRouter from "./admin-devis-rematch";
import adminInvoiceRematchRouter from "./admin-invoice-rematch";
import adminPageHintBackfillRouter from "./admin-page-hint-backfill";
import adminTransientFailuresRouter from "./admin-transient-failures";
import healthzRouter from "./healthz";

// IDOR / Tenancy assumption (single-tenant deployment):
// ArchiTrak runs as a dedicated single-firm deployment for Renosud
// (`@renosud.com` Google Workspace domain). All `@renosud.com` users
// authenticated via session cookies are treated as authorised operators
// for every resource in this database. There is intentionally NO
// row-level tenant ID, NO per-user ownership scoping on Project/Devis/
// Invoice/Certificat/Fee/Contractor/etc., and resource mutations
// (PATCH/DELETE) are NOT scoped to req.session.userId.
//
// If this app is ever multi-tenanted, every storage call below MUST be
// scoped by tenantId AND every mutation route MUST re-check that the
// target row belongs to the caller's tenant before write — the current
// `validateRequest` perimeter only checks shape, not ownership. Do NOT
// expose this server publicly without first adding row-level tenancy
// and ownership checks.

// Rate limiters: webhook is unauthenticated and takes external traffic, uploads
// hit AI extraction which is expensive, and the general API limiter is a
// belt-and-braces guard against runaway clients.
const webhookLimiter = rateLimit({ name: "webhook", windowMs: 60_000, max: 60, message: "Webhook rate limit exceeded" });
const uploadLimiter = rateLimit({ name: "upload", windowMs: 60_000, max: 20, message: "Upload rate limit exceeded" });
const apiLimiter = rateLimit({ name: "api", windowMs: 60_000, max: 600, message: "API rate limit exceeded" });

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Health endpoints are mounted BEFORE `/api/*` rate limiting & auth so
  // platform probes and the post-deploy smoke gate (Task #125) reach
  // them unauthenticated. The deep probe has its own per-caller
  // limiter inside the router.
  app.use(healthzRouter);

  app.use("/api/webhooks", webhookLimiter);
  app.use(["/api/devis/:devisId/invoices/upload", "/api/projects/:projectId/devis/upload"], uploadLimiter);
  app.use("/api", apiLimiter);

  app.use(projectsRouter);
  app.use(contractorsRouter);
  app.use(marchesRouter);
  app.use(lotsRouter);
  app.use(lotCatalogRouter);
  app.use(wishListRouter);
  app.use(devisRouter);
  app.use(devisChecksRouter);
  app.use(clientChecksRouter);
  app.use(insuranceGateRouter);
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
  app.use(archisignWebhooksRouter);
  app.use(archisignPublicRouter);
  app.use(archisignEnvelopesRouter);
  app.use(exportRouter);
  app.use(benchmarksRouter);
  app.use(adminDevisRematchRouter);
  app.use(adminInvoiceRematchRouter);
  app.use(adminPageHintBackfillRouter);
  app.use(adminTransientFailuresRouter);

  return httpServer;
}
