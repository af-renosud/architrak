import { storage } from "../storage";

export async function getProjectFinancialSummary(projectId: number) {
  const project = await storage.getProject(projectId);
  if (!project) {
    return { success: false, status: 404, data: { message: "Project not found" } };
  }

  const devisList = await storage.getDevisByProject(projectId);
  const projectInvoices = await storage.getInvoicesByProject(projectId);

  const devisSummaries = await Promise.all(
    devisList.map(async (d) => {
      const avs = await storage.getAvenantsByDevis(d.id);
      const devisInvoices = projectInvoices.filter((inv) => inv.devisId === d.id);

      const tvaRate = parseFloat(d.tvaRate) || 20;
      const tvaMultiplier = 1 + tvaRate / 100;
      const originalHt = parseFloat(d.amountHt);
      const originalTtc = parseFloat(d.amountTtc);
      const approvedAvenants = avs.filter((a) => a.status === "approved");
      const pvTotal = approvedAvenants
        .filter((a) => a.type === "pv")
        .reduce((sum, a) => sum + parseFloat(a.amountHt), 0);
      const mvTotal = approvedAvenants
        .filter((a) => a.type === "mv")
        .reduce((sum, a) => sum + parseFloat(a.amountHt), 0);
      const adjustedHt = originalHt + pvTotal - mvTotal;
      const adjustedTtc = adjustedHt * tvaMultiplier;

      const certifiedHt = devisInvoices.reduce(
        (sum, inv) => sum + parseFloat(inv.amountHt),
        0
      );
      const certifiedTtc = devisInvoices.reduce(
        (sum, inv) => sum + parseFloat(inv.amountTtc),
        0
      );

      const resteARealiser = adjustedHt - certifiedHt;
      const resteARealiserTtc = adjustedTtc - certifiedTtc;

      return {
        devisId: d.id,
        devisCode: d.devisCode,
        descriptionFr: d.descriptionFr,
        descriptionUk: d.descriptionUk,
        status: d.status,
        signOffStage: d.signOffStage,
        contractorId: d.contractorId,
        invoicingMode: d.invoicingMode,
        tvaRate,
        originalHt,
        originalTtc,
        pvTotal,
        mvTotal,
        adjustedHt,
        adjustedTtc,
        certifiedHt,
        certifiedTtc,
        resteARealiser,
        resteARealiserTtc,
        invoiceCount: devisInvoices.length,
        avenantCount: avs.length,
      };
    })
  );

  const activeDevis = devisSummaries.filter(ds => ds.status !== "void");
  const totals = activeDevis.reduce(
    (acc, ds) => ({
      totalContractedHt: acc.totalContractedHt + ds.adjustedHt,
      totalContractedTtc: acc.totalContractedTtc + ds.adjustedTtc,
      totalCertifiedHt: acc.totalCertifiedHt + ds.certifiedHt,
      totalCertifiedTtc: acc.totalCertifiedTtc + ds.certifiedTtc,
      totalResteARealiser: acc.totalResteARealiser + ds.resteARealiser,
      totalResteARealiserTtc: acc.totalResteARealiserTtc + ds.resteARealiserTtc,
      totalOriginalHt: acc.totalOriginalHt + ds.originalHt,
      totalOriginalTtc: acc.totalOriginalTtc + ds.originalTtc,
      totalPv: acc.totalPv + ds.pvTotal,
      totalMv: acc.totalMv + ds.mvTotal,
    }),
    {
      totalContractedHt: 0,
      totalContractedTtc: 0,
      totalCertifiedHt: 0,
      totalCertifiedTtc: 0,
      totalResteARealiser: 0,
      totalResteARealiserTtc: 0,
      totalOriginalHt: 0,
      totalOriginalTtc: 0,
      totalPv: 0,
      totalMv: 0,
    }
  );

  return {
    success: true,
    status: 200,
    data: {
      projectId,
      projectName: project.name,
      projectCode: project.code,
      devis: devisSummaries,
      ...totals,
    },
  };
}
