export async function convertHtmlToPdf(
  html: string,
  documentName: string,
  test: boolean = false
): Promise<Buffer> {
  const apiKey = process.env.DOCRAPTOR_API_KEY;
  if (!apiKey) {
    throw new Error("DOCRAPTOR_API_KEY is not set. Cannot generate PDF.");
  }

  const payload = {
    user_credentials: apiKey,
    doc: {
      document_content: html,
      type: "pdf" as const,
      name: documentName,
      test,
      javascript: false,
      prince_options: {
        media: "print",
      },
    },
  };

  const response = await fetch("https://docraptor.com/docs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `DocRaptor PDF generation failed (${response.status}): ${errorText}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
