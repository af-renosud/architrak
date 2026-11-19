/**
 * PDF column wrapping is not paragraph structure. Preserve every word and
 * punctuation mark while allowing quotation wording to wrap to its container.
 * Never apply this to rich context documents or original source evidence.
 */
export function quotationParagraph(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}
