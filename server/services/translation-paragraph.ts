/** Format generated descriptions only; never mutate the original source or manual edits. */
export function translationParagraph(text: string): string {
  const parts = text.split(/\r\n|\r|\n/)
    .map((part) => part.trim().replace(/^(?:[-*•▪◦–—]\s+|\d+[.)]\s+)/, "").trim())
    .filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  let paragraph = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const next = parts[i];
    // A heading or introductory fragment belongs to the following detail.
    if (/[:：]$/.test(paragraph) || /\bcomposed of$/i.test(paragraph)) {
      paragraph += ` ${next}`;
    } else {
      paragraph = paragraph.replace(/[,;.]$/, "");
      const last = i === parts.length - 1;
      paragraph += `${last ? ", " + (/^(?:and|or)\b/i.test(next) ? "" : "and ") : ", "}${next}`;
    }
  }
  return /[.!?]$/.test(paragraph) ? paragraph : `${paragraph}.`;
}