import { getUncachableGmailClient, isGmailConfigured } from "../gmail/client";
import { storage } from "../storage";
import { generateCertificatPdf, buildCertificatEmailBody } from "./certificat-generator";
import { getDocumentBuffer } from "../storage/object-storage";
import type { InsertProjectCommunication } from "@shared/schema";

export async function sendCertificat(certificatId: number): Promise<number> {
  const certificat = await storage.getCertificat(certificatId);
  if (!certificat) throw new Error(`Certificat ${certificatId} not found`);

  const project = await storage.getProject(certificat.projectId);
  if (!project) throw new Error(`Project not found`);

  const contractor = await storage.getContractor(certificat.contractorId);
  if (!contractor) throw new Error(`Contractor not found`);

  const { storageKey } = await generateCertificatPdf(certificatId);

  const subject = `Certificat de Paiement ${certificat.certificateRef} - ${project.name}`;
  const body = buildCertificatEmailBody({ certificat, project, contractor });

  const comm: InsertProjectCommunication = {
    projectId: project.id,
    type: "certificat_sent",
    recipientType: "client",
    recipientEmail: project.clientAddress || "",
    recipientName: project.clientName,
    subject,
    body,
    attachmentStorageKeys: [storageKey],
    status: "queued",
    relatedCertificatId: certificatId,
  };

  const created = await storage.createProjectCommunication(comm);
  return created.id;
}

export async function sendCommunication(communicationId: number): Promise<void> {
  if (!isGmailConfigured()) {
    throw new Error("Gmail not configured");
  }

  const comm = await storage.getProjectCommunication(communicationId);
  if (!comm) throw new Error(`Communication ${communicationId} not found`);

  if (comm.status !== "queued" && comm.status !== "draft") {
    throw new Error(`Communication is already ${comm.status}`);
  }

  try {
    const gmail = await getUncachableGmailClient();

    const attachments: Array<{ filename: string; content: string; contentType: string }> = [];
    const storageKeys = (comm.attachmentStorageKeys as string[]) || [];

    for (const key of storageKeys) {
      try {
        const buffer = await getDocumentBuffer(key);
        const filename = key.split("/").pop() || "attachment";
        let contentType = "application/octet-stream";
        if (filename.endsWith(".pdf")) contentType = "application/pdf";
        else if (filename.endsWith(".html")) contentType = "text/html";
        attachments.push({
          filename,
          content: buffer.toString("base64"),
          contentType,
        });
      } catch (err) {
        console.error(`[EmailSender] Failed to load attachment ${key}:`, err);
      }
    }

    const boundary = `boundary_${Date.now()}`;
    let rawEmail = [
      `From: me`,
      `To: ${comm.recipientEmail || ""}`,
      `Subject: ${comm.subject}`,
      `MIME-Version: 1.0`,
    ];

    if (attachments.length > 0) {
      rawEmail.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
      rawEmail.push("");
      rawEmail.push(`--${boundary}`);
      rawEmail.push(`Content-Type: text/plain; charset="UTF-8"`);
      rawEmail.push("");
      rawEmail.push(comm.body || "");

      for (const att of attachments) {
        rawEmail.push(`--${boundary}`);
        rawEmail.push(`Content-Type: ${att.contentType}; name="${att.filename}"`);
        rawEmail.push(`Content-Disposition: attachment; filename="${att.filename}"`);
        rawEmail.push(`Content-Transfer-Encoding: base64`);
        rawEmail.push("");
        rawEmail.push(att.content);
      }
      rawEmail.push(`--${boundary}--`);
    } else {
      rawEmail.push(`Content-Type: text/plain; charset="UTF-8"`);
      rawEmail.push("");
      rawEmail.push(comm.body || "");
    }

    const encodedMessage = Buffer.from(rawEmail.join("\r\n")).toString("base64url");

    const sendResult = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encodedMessage },
    });

    await storage.updateProjectCommunication(communicationId, {
      status: "sent",
      sentAt: new Date(),
      emailMessageId: sendResult.data.id || undefined,
      emailThreadId: sendResult.data.threadId || undefined,
    });

    console.log(`[EmailSender] Sent communication ${communicationId}: ${comm.subject}`);
  } catch (err: any) {
    await storage.updateProjectCommunication(communicationId, {
      status: "failed",
    });
    throw err;
  }
}

export async function sendPaymentChase(reminderId: number): Promise<void> {
  const reminder = await storage.getPaymentReminder(reminderId);
  if (!reminder) throw new Error(`Reminder ${reminderId} not found`);

  if (reminder.status !== "scheduled") {
    throw new Error(`Reminder is ${reminder.status}, not scheduled`);
  }

  const project = await storage.getProject(reminder.projectId);
  if (!project) throw new Error(`Project not found`);

  const templates: Record<string, { subject: string; body: string }> = {
    first: {
      subject: `Payment Reminder - ${project.name}`,
      body: `Dear Client,\n\nThis is a friendly reminder regarding the outstanding payment for project "${project.name}".\n\nPlease arrange payment at your earliest convenience.\n\nKind regards,\nSAS Architects-France`,
    },
    second: {
      subject: `Second Payment Reminder - ${project.name}`,
      body: `Dear Client,\n\nWe are writing to follow up on our previous reminder regarding the outstanding payment for project "${project.name}".\n\nWe would appreciate if you could arrange payment promptly.\n\nKind regards,\nSAS Architects-France`,
    },
    final: {
      subject: `Final Payment Reminder - ${project.name}`,
      body: `Dear Client,\n\nThis is our final reminder regarding the outstanding payment for project "${project.name}".\n\nPlease arrange payment immediately to avoid further action.\n\nKind regards,\nSAS Architects-France`,
    },
    overdue: {
      subject: `OVERDUE: Payment Required - ${project.name}`,
      body: `Dear Client,\n\nThe payment for project "${project.name}" is now overdue.\n\nPlease contact us immediately to discuss payment arrangements.\n\nKind regards,\nSAS Architects-France`,
    },
  };

  const template = templates[reminder.reminderType] || templates.first;

  const comm: InsertProjectCommunication = {
    projectId: project.id,
    type: "payment_chase",
    recipientType: reminder.recipientType,
    recipientEmail: reminder.recipientEmail,
    recipientName: project.clientName,
    subject: template.subject,
    body: template.body,
    status: "queued",
    relatedCertificatId: reminder.certificatId,
    relatedInvoiceId: reminder.invoiceId,
  };

  const created = await storage.createProjectCommunication(comm);

  try {
    await sendCommunication(created.id);
    await storage.updatePaymentReminder(reminderId, {
      status: "sent",
      sentAt: new Date(),
    });
  } catch (err) {
    console.error(`[EmailSender] Failed to send payment chase ${reminderId}:`, err);
    throw err;
  }
}
