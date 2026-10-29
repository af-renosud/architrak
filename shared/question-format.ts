/** Only attribute-free formatting tags are rendered. Everything else is text. */
export function renderQuestionHtml(value: string): string {
  return value.replace(/&(?!(?:amp|lt|gt|quot|#39);)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/&lt;(\/?)(p|strong|em|u|ul|ol|li|br)\s*\/?&gt;/gi, "<$1$2>")
    .replace(/\r?\n/g, "<br>");
}

export function questionPlainText(value: string): string {
  return value.replace(/<\/(?:p|li)>|<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:p|strong|em|u|ul|ol|li)>/gi, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
}
