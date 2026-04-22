import { z } from "zod";
import { createHash } from "crypto";
import { db } from "../db";
import { eq } from "drizzle-orm";
import { webhookEvents } from "@shared/schema";
import {
  upsertProject,
  upsertContractor,
  upsertTrade,
  upsertProposalFee,
  fullSync,
} from "../archidoc/sync-service";
import type {
  ArchidocProjectData,
  ArchidocContractorData,
  ArchidocTradeData,
} from "../archidoc/sync-client";
import { storage } from "../storage";
import { refreshProject } from "../archidoc/import-service";
import { normaliseSiretForStorage } from "../archidoc/contractor-auto-sync";
import { retry } from "../lib/retry";

export const webhookEventSchema = z.object({
  eventId: z.string().min(1).optional(),
  event: z.enum([
    "project.created",
    "project.updated",
    "project.deleted",
    "contractor.created",
    "contractor.updated",
    "contractor.deleted",
    "trade.created",
    "trade.updated",
    "trade.deleted",
    "proposal_fee.created",
    "proposal_fee.updated",
    "proposal_fee.deleted",
    "sync.full",
  ]),
  timestamp: z.string(),
  data: z.record(z.unknown()).optional().default({}),
});

export type WebhookEvent = z.infer<typeof webhookEventSchema>;

interface ProcessResult {
  processed: boolean;
  event: string;
  details: string;
  idempotent?: boolean;
}

function computeEventId(payload: WebhookEvent): string {
  if (payload.eventId) return payload.eventId;
  const hash = createHash("sha256")
    .update(`${payload.event}|${payload.timestamp}|${JSON.stringify(payload.data ?? {})}`)
    .digest("hex");
  return `derived:${hash}`;
}

export async function processWebhookEvent(payload: WebhookEvent): Promise<ProcessResult> {
  const { event, data } = payload;
  const eventId = computeEventId(payload);

  // Idempotency: skip if we've already processed this exact event id.
  const [existing] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, eventId));
  if (existing) {
    console.log(`[Webhook] Idempotency hit for event ${eventId} (${event}); skipping reprocess.`);
    return { processed: true, event, details: `Event ${eventId} already processed at ${existing.processedAt.toISOString()}`, idempotent: true };
  }

  console.log(`[Webhook] Processing event: ${event} (${eventId})`);

  switch (event) {
    case "project.created":
    case "project.updated": {
      const projectData = data as unknown as ArchidocProjectData;
      if (!projectData.id || !projectData.projectName) {
        throw new Error("project event requires 'id' and 'projectName' in data");
      }
      await retry(() => upsertProject(projectData), { retries: 2, onRetry: (e, a) => console.warn(`[Webhook] upsertProject retry ${a}`, (e as Error).message) });
      await autoRefreshTrackedProject(projectData.id);
      await markEventProcessed(eventId, event, payload);
      return { processed: true, event, details: `Project ${projectData.id} upserted in mirror` };
    }

    case "project.deleted": {
      const deletedProject = data as unknown as ArchidocProjectData;
      if (!deletedProject.id) {
        throw new Error("project.deleted event requires 'id' in data");
      }
      await upsertProject({ ...deletedProject, projectName: deletedProject.projectName || "Deleted", isDeleted: true });
      return { processed: true, event, details: `Project ${deletedProject.id} marked as deleted` };
    }

    case "contractor.created":
    case "contractor.updated": {
      const contractorData = data as unknown as ArchidocContractorData;
      if (!contractorData.id || !contractorData.name) {
        throw new Error("contractor event requires 'id' and 'name' in data");
      }
      await upsertContractor(contractorData);
      await autoRefreshTrackedContractor(contractorData.id);
      return { processed: true, event, details: `Contractor ${contractorData.id} upserted in mirror` };
    }

    case "contractor.deleted": {
      const deletedContractor = data as unknown as ArchidocContractorData;
      if (!deletedContractor.id) {
        throw new Error("contractor.deleted event requires 'id' in data");
      }
      await upsertContractor({ ...deletedContractor, name: deletedContractor.name || "Deleted" });
      return { processed: true, event, details: `Contractor ${deletedContractor.id} updated in mirror` };
    }

    case "trade.created":
    case "trade.updated": {
      const tradeData = data as unknown as ArchidocTradeData;
      if (!tradeData.id || !tradeData.label) {
        throw new Error(`${event} event requires 'id' and 'label' in data`);
      }
      await upsertTrade(tradeData);
      return { processed: true, event, details: `Trade ${tradeData.id} upserted in mirror` };
    }

    case "trade.deleted": {
      const deletedTrade = data as unknown as ArchidocTradeData;
      if (!deletedTrade.id) {
        throw new Error("trade.deleted event requires 'id' in data");
      }
      await upsertTrade({ ...deletedTrade, label: deletedTrade.label || "Deleted" });
      return { processed: true, event, details: `Trade ${deletedTrade.id} updated in mirror` };
    }

    case "proposal_fee.created":
    case "proposal_fee.updated": {
      const feeData = data as unknown as { projectId: string; proServiceHt?: number; proServiceTva?: number; proServiceTtc?: number; planningHt?: number; planningTva?: number; planningTtc?: number; pmPercentage?: number; pmNote?: string };
      if (!feeData.projectId) {
        throw new Error(`${event} event requires 'projectId' in data`);
      }
      await upsertProposalFee(feeData);
      return { processed: true, event, details: `Proposal fee for project ${feeData.projectId} upserted` };
    }

    case "proposal_fee.deleted": {
      const deletedFee = data as unknown as { projectId: string };
      if (!deletedFee.projectId) {
        throw new Error("proposal_fee.deleted event requires 'projectId' in data");
      }
      await upsertProposalFee({ projectId: deletedFee.projectId });
      return { processed: true, event, details: `Proposal fee for project ${deletedFee.projectId} cleared` };
    }

    case "sync.full": {
      const result = await fullSync();
      await markEventProcessed(eventId, event, payload);
      return {
        processed: true,
        event,
        details: `Full sync completed — projects: ${result.projects.updated}, contractors: ${result.contractors.updated}, trades: ${result.trades.updated}, fees: ${result.proposalFees.updated}`,
      };
    }

    default:
      throw new Error(`Unknown webhook event: ${event}`);
  }
}

async function markEventProcessed(eventId: string, eventType: string, payload: WebhookEvent) {
  const payloadHash = createHash("sha256").update(JSON.stringify(payload.data ?? {})).digest("hex");
  try {
    await db.insert(webhookEvents).values({ eventId, eventType, payloadHash }).onConflictDoNothing();
  } catch (err) {
    console.warn(`[Webhook] Failed to record processed event ${eventId}:`, (err as Error).message);
  }
}

async function autoRefreshTrackedProject(archidocId: string) {
  try {
    const project = await storage.getProjectByArchidocId(archidocId);
    if (project) {
      await refreshProject(project.id);
      console.log(`[Webhook] Auto-refreshed tracked project #${project.id} (${project.name})`);
    }
  } catch (err) {
    console.warn(`[Webhook] Auto-refresh for project ${archidocId} failed:`, err instanceof Error ? err.message : err);
  }
}

async function autoRefreshTrackedContractor(archidocContractorId: string) {
  try {
    const contractor = await storage.getContractorByArchidocId(archidocContractorId);
    if (contractor) {
      const mirrorContractor = await storage.getArchidocContractor(archidocContractorId);
      if (mirrorContractor) {
        const contacts = (mirrorContractor.contacts as any[]) || [];
        const primaryContact = contacts.find((c: any) => c.isPrimary) || contacts[0];
        await storage.updateContractor(contractor.id, {
          name: mirrorContractor.name,
          siret: normaliseSiretForStorage(mirrorContractor.siret),
          address: [mirrorContractor.address1, mirrorContractor.address2].filter(Boolean).join(", ") || undefined,
          email: primaryContact?.email || undefined,
          phone: mirrorContractor.officePhone || primaryContact?.mobile || undefined,
          contactName: primaryContact?.name || undefined,
          contactJobTitle: primaryContact?.jobTitle || undefined,
          contactMobile: primaryContact?.mobile || undefined,
          town: mirrorContractor.town || undefined,
          postcode: mirrorContractor.postcode || undefined,
          website: mirrorContractor.website || undefined,
          insuranceStatus: mirrorContractor.insuranceStatus || undefined,
          decennaleInsurer: mirrorContractor.decennaleInsurer || undefined,
          decennalePolicyNumber: mirrorContractor.decennalePolicyNumber || undefined,
          decennaleEndDate: mirrorContractor.decennaleEndDate || undefined,
          rcProInsurer: mirrorContractor.rcProInsurer || undefined,
          rcProPolicyNumber: mirrorContractor.rcProPolicyNumber || undefined,
          rcProEndDate: mirrorContractor.rcProEndDate || undefined,
          specialConditions: mirrorContractor.specialConditions || undefined,
        });
        console.log(`[Webhook] Auto-refreshed tracked contractor #${contractor.id} (${contractor.name})`);
      }
    }
  } catch (err) {
    console.warn(`[Webhook] Auto-refresh for contractor ${archidocContractorId} failed:`, err instanceof Error ? err.message : err);
  }
}
