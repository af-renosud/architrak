/** Numeric labels read independently of generative transcription. */
export function graphicDimensions(text: string): [number, number] | null {
  const match = text.match(/Dim[^\n:]{0,24}:\s*([\d .,]+)\s*mm\s*[xX×]\s*([\d .,]+)\s*mm/i);
  if (!match) return null;
  const number = (s: string) => Number(s.trim().replace(/\s/g, "").replace(/([.,])(?=\d{3}(?:\D|$))/g, "").replace(",", "."));
  const dimensions = [number(match[1]), number(match[2])] as [number, number];
  return dimensions.every(n => Number.isFinite(n) && n > 0) ? dimensions : null;
}
export function graphicEvidenceIssues(reference: string, independentText: string, description: string) {
  const issues: string[] = [];
  const compact = (s: string) => s.toUpperCase().replace(/[\s-]+/g, "");
  if (!compact(independentText).includes(compact(reference))) issues.push("Independent OCR does not corroborate the product reference");
  const source = graphicDimensions(independentText);
  const candidate = graphicDimensions(description);
  if (!source || !candidate || source[0] !== candidate[0] || source[1] !== candidate[1])
    issues.push("Graphic dimensions are missing or conflict with independent OCR");
  return issues;
}