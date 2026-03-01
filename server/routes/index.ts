import type { Express } from "express";
import { createServer, type Server } from "http";

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

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
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

  return httpServer;
}
