/**
 * Registry of command-specific stdout summarizers extracted from bash-server.ts.
 *
 * Each entry maps a command key to a summarizer function. The key is either:
 *   - a single word (e.g. "ls", "find", "ps")
 *   - a two-word prefix joined by "-" (e.g. "git-status", "npm-ls", "npm-audit")
 *   - a three-word prefix for docker/kubectl variants
 *
 * `findSummarizer` parses a raw command string and returns the matching fn or null.
 */

import { basename } from "path";

// ---------------------------------------------------------------------------
// Individual summarizer functions (exact copies from bash-server.ts)
// ---------------------------------------------------------------------------

function summarizeGitStatus(stdout: string, branchHint?: string): string {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  const counts = new Map<string, number>();
  for (const line of lines) {
    const code = line.slice(0, 2).trim() || line.slice(0, 2);
    const key = code === "" ? "?" : code;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [k, v] of [...counts.entries()].sort()) {
    parts.push(`${k}: ${v}`);
  }
  const branch = branchHint ? ` · branch ${branchHint}` : "";
  return parts.length === 0
    ? `clean${branch}`
    : `${parts.join(", ")}${branch}`;
}

function summarizeLs(stdout: string): string | null {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length <= 40) return null;
  const head = lines.slice(0, 20).join("\n");
  const tail = lines.slice(-10).join("\n");
  return `${head}\n[... ${lines.length - 30} more entries elided ...]\n${tail}\n· ${lines.length} entries total`;
}

function summarizeFind(stdout: string): string | null {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length <= 100) return null;
  const head = lines.slice(0, 50).join("\n");
  return `${head}\n[... ${lines.length - 50} more matches elided ...]\n· ${lines.length} matches total`;
}

function summarizePs(stdout: string, cwd: string): string | null {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length <= 100) return null;
  const cwdName = basename(cwd);
  const header = lines[0]!;
  const filtered = lines.slice(1).filter((l) => cwdName && l.includes(cwdName));
  if (filtered.length > 0 && filtered.length < lines.length - 1) {
    return `${header}\n${filtered.join("\n")}\n· filtered ${filtered.length} of ${lines.length - 1} processes by cwd name '${cwdName}'`;
  }
  return null;
}

function summarizeNpmLs(stdout: string): string | null {
  const lines = stdout.split("\n");
  if (lines.length < 50) return null;
  const seenWarn = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const w = line.match(/(deduped|UNMET|invalid)/);
    if (w) {
      const sig = line.trim();
      if (seenWarn.has(sig)) continue;
      seenWarn.add(sig);
    }
    const depth = (line.match(/[│├└]\s/g) ?? []).length;
    if (depth > 2) continue;
    kept.push(line);
  }
  if (kept.length >= lines.length) return null;
  return `${kept.join("\n")}\n· collapsed depth>2 and deduped warnings (${lines.length} → ${kept.length} lines)`;
}

function summarizeDockerPs(stdout: string): string | null {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length < 3) return null;

  const header = lines[0]!;
  const rows = lines.slice(1);

  interface DockerRow { id: string; image: string; status: string; ports: string; raw: string }
  const KNOWN = ["CONTAINER ID", "IMAGE", "COMMAND", "CREATED", "STATUS", "PORTS", "NAMES"] as const;
  const starts: Array<{ name: string; start: number }> = [];
  for (const name of KNOWN) {
    const idx = header.indexOf(name);
    if (idx >= 0) starts.push({ name, start: idx });
  }
  if (starts.length < 3) return null;

  function sliceCol(row: string, name: typeof KNOWN[number]): string {
    const i = starts.findIndex((s) => s.name === name);
    if (i < 0) return "";
    const start = starts[i]!.start;
    const end = starts[i + 1]?.start ?? row.length;
    return row.slice(start, end).trim();
  }

  const parsed: DockerRow[] = rows.map((raw) => ({
    id: sliceCol(raw, "CONTAINER ID").slice(0, 12),
    image: sliceCol(raw, "IMAGE"),
    status: sliceCol(raw, "STATUS"),
    ports: sliceCol(raw, "PORTS"),
    raw,
  }));

  const groups = new Map<string, { rows: DockerRow[]; ports: Set<string> }>();
  for (const row of parsed) {
    const key = `${row.image}||${row.status}`;
    const g = groups.get(key) ?? { rows: [], ports: new Set() };
    g.rows.push(row);
    if (row.ports) g.ports.add(row.ports);
    groups.set(key, g);
  }

  const out: string[] = [header];
  for (const g of groups.values()) {
    if (g.rows.length === 1) {
      out.push(g.rows[0]!.raw);
    } else {
      const r = g.rows[0]!;
      const ports = g.ports.size > 0 ? `  ports: ${[...g.ports].join(", ")}` : "";
      out.push(`${r.image}  ×${g.rows.length} containers  ${r.status}${ports}`);
    }
  }
  if (out.length >= lines.length) return null;
  out.push(`· ${rows.length} containers total (${groups.size} distinct image/status groups)`);
  return out.join("\n");
}

function summarizeKubectlGet(stdout: string): string | null {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length < 4) return null;

  const header = lines[0]!;
  const cols = header.trim().split(/\s+/);
  const nsIdx = cols.findIndex((c) => c.toUpperCase() === "NAMESPACE");
  const statusIdx = cols.findIndex((c) => c.toUpperCase() === "STATUS" || c.toUpperCase() === "READY");
  const ageIdx = cols.findIndex((c) => c.toUpperCase() === "AGE");
  const nameIdx = cols.findIndex((c) => c.toUpperCase() === "NAME");

  const rows = lines.slice(1);

  const byNs = new Map<string, string[]>();
  for (const row of rows) {
    const parts = row.trim().split(/\s+/);
    const ns = nsIdx >= 0 ? (parts[nsIdx] ?? "default") : "default";
    const arr = byNs.get(ns) ?? [];
    arr.push(row);
    byNs.set(ns, arr);
  }

  if (byNs.size === 1) return null;

  const out: string[] = [header];
  for (const [ns, nsRows] of byNs) {
    const statusCounts = new Map<string, number>();
    for (const row of nsRows) {
      const parts = row.trim().split(/\s+/);
      const st = statusIdx >= 0 ? (parts[statusIdx] ?? "?") : "?";
      statusCounts.set(st, (statusCounts.get(st) ?? 0) + 1);
    }
    const statusSummary = [...statusCounts.entries()]
      .map(([st, n]) => `${st}: ${n}`)
      .join(", ");

    const ages: string[] = [];
    if (ageIdx >= 0) {
      const first = nsRows[0]!.trim().split(/\s+/)[ageIdx];
      const last = nsRows[nsRows.length - 1]!.trim().split(/\s+/)[ageIdx];
      if (first) ages.push(`oldest ${first}`);
      if (last && last !== first) ages.push(`newest ${last}`);
    }
    const ageNote = ages.length ? `  age: ${ages.join("/")}` : "";
    void nameIdx;
    out.push(`namespace=${ns}  ${nsRows.length} resources  [${statusSummary}]${ageNote}`);
  }
  out.push(`· ${rows.length} resources total across ${byNs.size} namespace(s)`);
  return out.join("\n");
}

function summarizeNpmAudit(stdout: string): string | null {
  const lines = stdout.split("\n");
  if (lines.length < 10) return null;

  if (stdout.trimStart().startsWith("{")) {
    try {
      const j = JSON.parse(stdout) as {
        metadata?: { vulnerabilities?: Record<string, number> };
        vulnerabilities?: Record<string, { severity: string; via: Array<string | { url?: string; title?: string }> }>;
      };
      const vuln = j.metadata?.vulnerabilities ?? {};
      const severitySummary = Object.entries(vuln)
        .filter(([, n]) => n > 0)
        .map(([sev, n]) => `${sev}: ${n}`)
        .join(", ");
      const advisories = Object.entries(j.vulnerabilities ?? {})
        .slice(0, 10)
        .map(([pkg, v]) => {
          const via = v.via.find((x) => typeof x === "object") as { title?: string; url?: string } | undefined;
          const title = via?.title ?? v.severity;
          return `  ${pkg} (${v.severity}): ${title}`;
        });
      const lines2: string[] = [];
      if (severitySummary) lines2.push(`npm audit: ${severitySummary}`);
      lines2.push(...advisories);
      if (advisories.length < Object.keys(j.vulnerabilities ?? {}).length) {
        lines2.push(`  … ${Object.keys(j.vulnerabilities ?? {}).length - advisories.length} more`);
      }
      return lines2.length > 1 ? lines2.join("\n") : null;
    } catch {
      // Fall through to text parsing.
    }
  }

  const severityCounts: Record<string, number> = {};
  const vulnLines: string[] = [];
  let foundLine = "";

  for (const line of lines) {
    const sevMatch = line.match(/^\s*(critical|high|moderate|low|info)\s+(.+)/i);
    if (sevMatch) {
      const sev = sevMatch[1]!.toLowerCase();
      severityCounts[sev] = (severityCounts[sev] ?? 0) + 1;
      if (vulnLines.length < 10) vulnLines.push(`  ${sev}: ${sevMatch[2]!.trim()}`);
    }
    if (/found \d+ vulnerabilit/i.test(line)) foundLine = line.trim();
  }

  if (Object.keys(severityCounts).length === 0) return null;

  const summary = Object.entries(severityCounts)
    .map(([sev, n]) => `${sev}: ${n}`)
    .join(", ");
  const out = [`npm audit: ${summary}`];
  out.push(...vulnLines);
  if (foundLine) out.push(foundLine);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Map of command key → summarizer.
 * Keys use "-" to join multi-word prefixes (e.g. "git-status", "npm-ls").
 *
 * Note: summarizePs and summarizeGitStatus need extra context (cwd / branch).
 * Their registry entries receive only stdout; callers that need the full
 * behaviour (branch lookup, cwd filtering) use tryStructuredSummary directly.
 * These entries are included so findSummarizer can report a match exists.
 */
export const BASH_SUMMARIZERS: Map<string, (stdout: string) => string | null> = new Map([
  ["git-status", (stdout) => summarizeGitStatus(stdout)],
  ["ls", summarizeLs],
  ["find", summarizeFind],
  ["ps", (stdout) => summarizePs(stdout, process.cwd())],
  ["npm-ls", summarizeNpmLs],
  ["bun-pm-ls", summarizeNpmLs],
  ["docker-ps", summarizeDockerPs],
  ["docker-compose-ps", summarizeDockerPs],
  ["docker-container-ls", summarizeDockerPs],
  ["kubectl-get", summarizeKubectlGet],
  ["npm-audit", summarizeNpmAudit],
]);

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Parse a raw command string and return the matching summarizer, or null.
 *
 * Matching order (most-specific first):
 *   1. Three-word prefix: word0-word1-word2  (e.g. "docker container ls")
 *   2. Two-word prefix:   word0-word1        (e.g. "git status", "npm audit")
 *   3. One-word prefix:   word0              (e.g. "ls", "find")
 */
export function findSummarizer(
  command: string,
): ((stdout: string) => string | null) | null {
  const words = command.trim().split(/\s+/);
  if (words.length === 0) return null;

  const w0 = words[0] ?? "";
  const w1 = words[1] ?? "";
  const w2 = words[2] ?? "";

  // Three-word key.
  if (w2) {
    const key3 = `${w0}-${w1}-${w2}`;
    const fn3 = BASH_SUMMARIZERS.get(key3);
    if (fn3) return fn3;
  }

  // Two-word key.
  if (w1) {
    const key2 = `${w0}-${w1}`;
    const fn2 = BASH_SUMMARIZERS.get(key2);
    if (fn2) return fn2;
  }

  // One-word key.
  return BASH_SUMMARIZERS.get(w0) ?? null;
}

// Re-export internals for testing.
export {
  summarizeGitStatus,
  summarizeLs,
  summarizeFind,
  summarizePs,
  summarizeNpmLs,
  summarizeDockerPs,
  summarizeKubectlGet,
  summarizeNpmAudit,
};
