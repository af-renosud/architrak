import { storage } from "../storage";
import type { ArchidocProject, ArchidocContractor, InsertProject, InsertContractor, InsertLot, InsertFee } from "@shared/schema";
import { normaliseSiretForStorage } from "./contractor-auto-sync";

interface TrackProjectOptions {
  tvaRate?: string;
  feeType?: string;
  feePercentage?: string;
  conceptionFee?: string;
  planningFee?: string;
  hasMarche?: boolean;
}

interface TrackProjectResult {
  projectId: number;
  contractorsCreated: number;
  lotsCreated: number;
  feesCreated: number;
}

export async function trackProject(archidocId: string, options: TrackProjectOptions = {}): Promise<TrackProjectResult> {
  const existing = await storage.getProjectByArchidocId(archidocId);
  if (existing) {
    throw new Error(`Project with ArchiDoc ID ${archidocId} is already tracked (project #${existing.id})`);
  }

  const mirrorProject = await storage.getArchidocProject(archidocId);
  if (!mirrorProject) {
    throw new Error(`ArchiDoc project ${archidocId} not found in mirror tables. Run sync first.`);
  }

  const clients = (mirrorProject.clients as any[]) || [];
  const clientAddress = extractClientAddress(clients);

  const existingByName = await storage.getProjectByName(mirrorProject.projectName);
  let project;
  const nameMatch = existingByName && !existingByName.archidocId;
  const clientMatch = nameMatch && mirrorProject.clientName &&
    existingByName.clientName.toLowerCase().includes(mirrorProject.clientName.toLowerCase().split(" ")[0]);
  if (nameMatch && clientMatch) {
    await storage.updateProject(existingByName.id, {
      archidocId: archidocId,
      clientName: mirrorProject.clientName || existingByName.clientName,
      clientAddress: clientAddress || existingByName.clientAddress,
      siteAddress: mirrorProject.address || existingByName.siteAddress,
      archidocClients: mirrorProject.clients as Record<string, unknown> | null,
      lastSyncedAt: new Date(),
    });
    project = (await storage.getProject(existingByName.id))!;
    console.log(`[Import] Linked existing project "${project.name}" (#${project.id}) to ArchiDoc ID ${archidocId}`);
  } else {
    const projectData: InsertProject = {
      name: mirrorProject.projectName,
      code: mirrorProject.code || `AD-${archidocId.slice(0, 8).toUpperCase()}`,
      clientName: mirrorProject.clientName || "Unknown Client",
      clientAddress: clientAddress,
      siteAddress: mirrorProject.address,
      status: "active",
      tvaRate: options.tvaRate || "20.00",
      feeType: options.feeType || "percentage",
      feePercentage: options.feePercentage,
      conceptionFee: options.conceptionFee,
      planningFee: options.planningFee,
      hasMarche: options.hasMarche || false,
      archidocId: archidocId,
      archidocClients: mirrorProject.clients as Record<string, unknown> | null,
      lastSyncedAt: new Date(),
    };
    project = await storage.createProject(projectData);
  }
  let contractorsCreated = 0;
  let lotsCreated = 0;
  let feesCreated = 0;

  const lotContractors = (mirrorProject.lotContractors as any[]) || [];
  const customLots = (mirrorProject.customLots as any[]) || [];

  const contractorArchidocIds = new Set<string>();
  for (const lc of lotContractors) {
    if (lc.contractorId) {
      contractorArchidocIds.add(String(lc.contractorId));
    }
  }

  const contractorIdMap = new Map<string, number>();

  for (const archidocContractorId of Array.from(contractorArchidocIds)) {
    let contractor = await storage.getContractorByArchidocId(archidocContractorId);
    if (!contractor) {
      const mirrorContractor = await storage.getArchidocContractor(archidocContractorId);
      if (mirrorContractor) {
        contractor = await createContractorFromMirror(mirrorContractor);
        contractorsCreated++;
      }
    }
    if (contractor) {
      contractorIdMap.set(archidocContractorId, contractor.id);
    }
  }

  const createdLotNumbers = new Set<string>();

  if (customLots.length > 0) {
    for (const lotData of customLots) {
      const lotNumber = String(lotData.lotNumber || lotData.sortOrder || `LOT${createdLotNumbers.size + 1}`);
      if (createdLotNumbers.has(lotNumber)) continue;
      createdLotNumbers.add(lotNumber);
      await storage.createLot({
        projectId: project.id,
        lotNumber,
        descriptionFr: lotData.label || lotData.descriptionFr || `Lot ${lotNumber}`,
        descriptionUk: lotData.descriptionUk,
      });
      lotsCreated++;
    }
  } else {
    for (const lc of lotContractors) {
      const lotNumber = String(lc.lotNumber || `LOT${createdLotNumbers.size + 1}`);
      if (createdLotNumbers.has(lotNumber)) continue;
      createdLotNumbers.add(lotNumber);
      const contractorName = contractorIdMap.has(String(lc.contractorId))
        ? (await storage.getContractor(contractorIdMap.get(String(lc.contractorId))!))?.name
        : null;
      await storage.createLot({
        projectId: project.id,
        lotNumber,
        descriptionFr: contractorName ? `${lotNumber} — ${contractorName}` : `Lot ${lotNumber}`,
      });
      lotsCreated++;
    }
  }

  const proposalFees = await storage.getArchidocProposalFees(archidocId);
  if (proposalFees.length > 0) {
    const pf = proposalFees[0];

    if (pf.proServiceHt && parseFloat(pf.proServiceHt) > 0) {
      const feeData: InsertFee = {
        projectId: project.id,
        feeType: "conception",
        baseAmountHt: "0.00",
        feeRate: options.feePercentage,
        feeAmountHt: pf.proServiceHt,
        feeAmountTtc: pf.proServiceTtc || pf.proServiceHt,
        invoicedAmount: "0.00",
        remainingAmount: pf.proServiceHt,
        status: "pending",
      };
      await storage.createFee(feeData);
      feesCreated++;
    }

    if (pf.planningHt && parseFloat(pf.planningHt) > 0) {
      const feeData: InsertFee = {
        projectId: project.id,
        feeType: "planning",
        baseAmountHt: "0.00",
        feeRate: null,
        feeAmountHt: pf.planningHt,
        feeAmountTtc: pf.planningTtc || pf.planningHt,
        invoicedAmount: "0.00",
        remainingAmount: pf.planningHt,
        status: "pending",
      };
      await storage.createFee(feeData);
      feesCreated++;
    }
  }

  return {
    projectId: project.id,
    contractorsCreated,
    lotsCreated,
    feesCreated,
  };
}

export async function refreshProject(projectId: number): Promise<{ updated: boolean; details: string }> {
  const project = await storage.getProject(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }
  if (!project.archidocId) {
    throw new Error(`Project ${projectId} is not linked to ArchiDoc`);
  }

  const mirrorProject = await storage.getArchidocProject(project.archidocId);
  if (!mirrorProject) {
    throw new Error(`ArchiDoc project ${project.archidocId} not found in mirror tables. Run sync first.`);
  }

  const refreshClients = (mirrorProject.clients as any[]) || [];
  const refreshClientAddress = extractClientAddress(refreshClients);

  await storage.updateProject(projectId, {
    name: mirrorProject.projectName,
    clientName: mirrorProject.clientName || project.clientName,
    clientAddress: refreshClientAddress || project.clientAddress,
    siteAddress: mirrorProject.address || project.siteAddress,
    archidocClients: mirrorProject.clients as Record<string, unknown> | null,
    lastSyncedAt: new Date(),
  });

  const lotContractors = (mirrorProject.lotContractors as any[]) || [];
  let contractorsUpdated = 0;

  const contractorArchidocIds = new Set<string>();
  for (const lc of lotContractors) {
    if (lc.contractorId) {
      contractorArchidocIds.add(String(lc.contractorId));
    }
  }

  for (const archidocContractorId of Array.from(contractorArchidocIds)) {
    const mirrorContractor = await storage.getArchidocContractor(archidocContractorId);
    if (!mirrorContractor) continue;

    let contractor = await storage.getContractorByArchidocId(archidocContractorId);
    if (contractor) {
      await updateContractorFromMirror(contractor.id, mirrorContractor);
      contractorsUpdated++;
    } else {
      await createContractorFromMirror(mirrorContractor);
      contractorsUpdated++;
    }
  }

  return {
    updated: true,
    details: `Project refreshed. ${contractorsUpdated} contractor(s) updated/created.`,
  };
}

function extractClientAddress(clients: any[]): string | null {
  for (const c of clients) {
    const addr = c.homeAddress || c.address;
    if (addr && typeof addr === "string" && addr.trim().length > 0) {
      return addr.trim();
    }
  }
  return null;
}

async function createContractorFromMirror(mirror: ArchidocContractor) {
  const contacts = (mirror.contacts as any[]) || [];
  const primaryContact = contacts.find((c: any) => c.isPrimary) || contacts[0];

  const contractorData: InsertContractor = {
    name: mirror.name,
    siret: normaliseSiretForStorage(mirror.siret),
    address: [mirror.address1, mirror.address2].filter(Boolean).join(", ") || null,
    email: primaryContact?.email || null,
    phone: mirror.officePhone || primaryContact?.mobile || null,
    archidocId: mirror.archidocId,
    contactName: primaryContact?.name || null,
    contactJobTitle: primaryContact?.jobTitle || null,
    contactMobile: primaryContact?.mobile || null,
    town: mirror.town,
    postcode: mirror.postcode,
    website: mirror.website,
    insuranceStatus: mirror.insuranceStatus,
    decennaleInsurer: mirror.decennaleInsurer,
    decennalePolicyNumber: mirror.decennalePolicyNumber,
    decennaleEndDate: mirror.decennaleEndDate,
    rcProInsurer: mirror.rcProInsurer,
    rcProPolicyNumber: mirror.rcProPolicyNumber,
    rcProEndDate: mirror.rcProEndDate,
    specialConditions: mirror.specialConditions,
  };

  return storage.createContractor(contractorData);
}

async function updateContractorFromMirror(contractorId: number, mirror: ArchidocContractor) {
  const contacts = (mirror.contacts as any[]) || [];
  const primaryContact = contacts.find((c: any) => c.isPrimary) || contacts[0];

  return storage.updateContractor(contractorId, {
    name: mirror.name,
    siret: normaliseSiretForStorage(mirror.siret),
    address: [mirror.address1, mirror.address2].filter(Boolean).join(", ") || undefined,
    email: primaryContact?.email || undefined,
    phone: mirror.officePhone || primaryContact?.mobile || undefined,
    contactName: primaryContact?.name || undefined,
    contactJobTitle: primaryContact?.jobTitle || undefined,
    contactMobile: primaryContact?.mobile || undefined,
    town: mirror.town || undefined,
    postcode: mirror.postcode || undefined,
    website: mirror.website || undefined,
    insuranceStatus: mirror.insuranceStatus || undefined,
    decennaleInsurer: mirror.decennaleInsurer || undefined,
    decennalePolicyNumber: mirror.decennalePolicyNumber || undefined,
    decennaleEndDate: mirror.decennaleEndDate || undefined,
    rcProInsurer: mirror.rcProInsurer || undefined,
    rcProPolicyNumber: mirror.rcProPolicyNumber || undefined,
    rcProEndDate: mirror.rcProEndDate || undefined,
    specialConditions: mirror.specialConditions || undefined,
  });
}
