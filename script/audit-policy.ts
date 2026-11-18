/** User-approved, temporary risk acceptance; not a vulnerability fix. */
export const PICOMATCH_EXCEPTION = {
  url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
  expiresAt: "2026-12-02T00:00:00Z",
};

type Finding = {
  severity: string;
  via: Array<string | { name: string; url: string; severity: string }>;
};

export function assessAudit(report: any, now = new Date()) {
  if (report.error || !report.metadata?.vulnerabilities || !report.vulnerabilities) {
    throw new Error("Missing or invalid npm audit report");
  }
  const findings = report.vulnerabilities as Record<string, Finding>;
  const permitted = new Set(["picomatch", "fdir", "tinyglobby", "vite", "vitest"]);
  function excepted(name: string, seen = new Set<string>()): boolean {
    const finding = findings[name];
    if (now >= new Date(PICOMATCH_EXCEPTION.expiresAt) || !permitted.has(name)
      || seen.has(name) || !finding || finding.severity !== "high"
      || !Array.isArray(finding.via) || !finding.via.length) return false;
    const visited = new Set(seen).add(name);
    return finding.via.every(v => typeof v === "string"
      ? excepted(v, visited)
      : v.name === "picomatch" && v.url === PICOMATCH_EXCEPTION.url && v.severity === "high");
  }
  const blocking: string[] = [];
  const accepted: string[] = [];
  for (const [name, finding] of Object.entries(findings)) {
    if (!["high", "critical"].includes(finding.severity)) continue;
    (excepted(name) ? accepted : blocking).push(name);
  }
  const count = (report.metadata.vulnerabilities.high ?? 0) + (report.metadata.vulnerabilities.critical ?? 0);
  if (count !== blocking.length + accepted.length) throw new Error("Audit finding counts disagree");
  return { blocking, accepted };
}
