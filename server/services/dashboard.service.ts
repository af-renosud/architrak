import { storage } from "../storage";
import { getGmailMonitorStatus } from "../gmail/monitor";

export async function getDashboardSummary() {
  const allProjects = await storage.getProjects();
  const recentInvoices = await storage.getRecentInvoices(10);
  const recentCertificats = await storage.getRecentCertificats(10);
  const allInvoices = await storage.getAllInvoices();
  const allCertificatsData = await storage.getAllCertificats();
  const contractors = await storage.getContractors();
  const allEmailDocs = await storage.getEmailDocuments();

  const contractorMap = new Map(contractors.map(c => [c.id, c.name]));
  const gmailStatus = getGmailMonitorStatus();

  const projectSummaries = await Promise.all(
    allProjects.map(async (project) => {
      const projectDevis = await storage.getDevisByProject(project.id);
      const projectInvoices = allInvoices.filter(inv => inv.projectId === project.id);
      const projectEmailDocs = allEmailDocs.filter(d => d.projectId === project.id);

      const activeDevis = projectDevis.filter(d => d.status !== "void");
      const approvedStatuses = ["approved", "sent", "signed"];
      const devisApprovedCount = activeDevis.filter(d => approvedStatuses.includes(d.status)).length;
      const devisUnapprovedCount = activeDevis.length - devisApprovedCount;
      const allDevisSigned = activeDevis.length > 0 && activeDevis.every(d => d.signOffStage === "signed");

      const invoiceApprovedCount = projectInvoices.filter(inv => inv.status === "approved").length;
      const invoiceUnapprovedCount = projectInvoices.filter(inv => inv.status === "pending").length;

      const agentIssues = projectEmailDocs.filter(d => d.extractionStatus === "pending" || d.extractionStatus === "needs_review");
      const agentStatus = agentIssues.length > 0 ? "warning" : "ok";

      return {
        id: project.id,
        name: project.name,
        code: project.code,
        clientName: project.clientName,
        status: project.status,
        devisCount: activeDevis.length,
        devisApprovedCount,
        devisUnapprovedCount,
        allDevisSigned,
        invoiceCount: projectInvoices.length,
        invoiceApprovedCount,
        invoiceUnapprovedCount,
        agentStatus,
        agentIssueCount: agentIssues.length,
      };
    })
  );

  const overdueInvoices = allInvoices.filter(inv => inv.status === "overdue");
  const pendingCertificats = allCertificatsData.filter(c => c.status === "draft" || c.status === "ready");

  const urgentItems: Array<{ type: string; label: string; projectId: number; id: number; amount: string }> = [];
  for (const inv of overdueInvoices) {
    urgentItems.push({
      type: "overdue_invoice",
      label: `Facture F${inv.invoiceNumber} en retard`,
      projectId: inv.projectId,
      id: inv.id,
      amount: inv.amountTtc,
    });
  }
  for (const cert of pendingCertificats) {
    urgentItems.push({
      type: cert.status === "draft" ? "cert_draft" : "cert_review",
      label: `Certificat ${cert.certificateRef} — ${cert.status === "draft" ? "brouillon" : "en attente de revue"}`,
      projectId: cert.projectId,
      id: cert.id,
      amount: cert.netToPayTtc,
    });
  }

  for (const ps of projectSummaries) {
    if ((ps as any).anomalyCount > 0) {
      urgentItems.push({
        type: "anomaly",
        label: `${ps.code} — ${(ps as any).anomalyCount} anomalie${(ps as any).anomalyCount > 1 ? "s" : ""} détectée${(ps as any).anomalyCount > 1 ? "s" : ""}`,
        projectId: ps.id,
        id: ps.id,
        amount: "0",
      });
    }
  }

  const recentActivity: Array<{ type: string; label: string; date: string | null; amount: string; projectId: number; contractor: string }> = [];
  for (const inv of recentInvoices) {
    recentActivity.push({
      type: "invoice",
      label: `Facture F${inv.invoiceNumber}${inv.certificateNumber ? ` (${inv.certificateNumber})` : ""}`,
      date: inv.dateIssued ?? inv.createdAt?.toISOString().split("T")[0] ?? null,
      amount: inv.amountTtc,
      projectId: inv.projectId,
      contractor: contractorMap.get(inv.contractorId) ?? `#${inv.contractorId}`,
    });
  }
  for (const cert of recentCertificats) {
    recentActivity.push({
      type: "certificat",
      label: `Certificat ${cert.certificateRef}`,
      date: cert.dateIssued ?? cert.createdAt?.toISOString().split("T")[0] ?? null,
      amount: cert.netToPayTtc,
      projectId: cert.projectId,
      contractor: contractorMap.get(cert.contractorId) ?? `#${cert.contractorId}`,
    });
  }

  recentActivity.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });

  return {
    gmailLastCheck: gmailStatus.lastPollTime,
    gmailPolling: gmailStatus.polling,
    overview: {
      activeProjects: allProjects.filter(p => p.status === "active").length,
      totalProjects: allProjects.length,
    },
    projectSummaries,
    recentActivity: recentActivity.slice(0, 15),
    urgentItems,
  };
}
