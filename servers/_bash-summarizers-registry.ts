/**
 * Registry of command-specific stdout summarizers extracted from bash-server.ts.
 *
 * Each entry maps a command key to a summarizer function. The key is either:
 *   - a single word (e.g. "ls", "find", "ps")
 *   - a two-word prefix joined by "-" (e.g. "git-status", "npm-ls", "npm-audit")
 *   - a three-word prefix for docker/kubectl variants
 *
 * `findSummarizer` parses a raw command string and returns the matching fn or null.
 *
 * Summarizers are purely synchronous and size-bounded — they do head/tail slicing,
 * count aggregation, and regex extraction only. For LLM-grade summarization of
 * large diff-like outputs (git diff, git show), callers should route through
 * `summarizeIfLarge` with `PROMPTS.diff` instead; those commands are flagged by
 * the `isLargeDiffCommand` helper below.
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
// v1.18 high-frequency additions
// ---------------------------------------------------------------------------

/**
 * `git log` — keep last 10 commits (SHA + subject) plus a total-count footer
 * when the log runs longer than 10 entries. Works against the common one-line
 * formats (`--oneline`, default `commit <sha>` / `Author:` / blank / subject).
 *
 * Recognized shapes:
 *   "<sha> subject line"           (--oneline / --format=%h %s)
 *   "commit <sha>\nAuthor: …\n\n    subject"   (default porcelain log)
 */
function summarizeGitLog(stdout: string): string | null {
  const text = stdout.replace(/\r\n/g, "\n");
  if (text.length === 0) return null;

  // Try parse default log shape: blocks separated by "commit <sha>" boundaries.
  const commits: Array<{ sha: string; subject: string }> = [];
  if (/^commit\s+[0-9a-f]{7,40}\b/m.test(text)) {
    const blocks = text.split(/^commit\s+/m).slice(1);
    for (const block of blocks) {
      const shaMatch = block.match(/^([0-9a-f]{7,40})/);
      if (!shaMatch) continue;
      const sha = shaMatch[1]!.slice(0, 7);
      // Subject is the first non-empty indented or trailing line.
      const lines = block.split("\n").map((l) => l.trim());
      // Skip headers (Author:, Date:, Merge:, etc.), pick first line after blank.
      let subject = "";
      let inBody = false;
      for (const l of lines.slice(1)) {
        if (!inBody) {
          if (l === "") { inBody = true; continue; }
          continue;
        }
        if (l.length > 0) { subject = l; break; }
      }
      commits.push({ sha, subject });
    }
  } else {
    // Assume --oneline shape: "<sha> <subject>"
    const lines = text.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      const m = line.match(/^([0-9a-f]{7,40})\s+(.+)$/);
      if (m) commits.push({ sha: m[1]!.slice(0, 7), subject: m[2]! });
    }
  }

  if (commits.length <= 10) return null;
  const keep = commits.slice(0, 10);
  const rendered = keep.map((c) => `${c.sha} ${c.subject}`).join("\n");
  return `${rendered}\n· ${commits.length} commits total (showing 10 most recent)`;
}

/**
 * Test-runner output — unified summarizer matching jest / vitest / bun test /
 * pytest / mocha / jasmine output shapes. Preserves: first ≤3 failing test
 * descriptions (with file:line where available), final pass/fail line, total
 * count. Drops verbose per-test "PASS" output.
 *
 * Detection is output-shape based, not command-arg based, so the same
 * summarizer handles `jest`, `vitest`, `bun test`, `pytest`, `npm test`, etc.
 */
function summarizeTestRunner(stdout: string): string | null {
  if (stdout.length < 200) return null;
  const lines = stdout.split("\n");

  // Runner-specific final-line patterns.
  const patterns: Array<{ re: RegExp; runner: string }> = [
    { re: /^Tests?:\s+.*(?:passed|failed|skipped)/i, runner: "jest" },
    { re: /^Test\s+Suites?:/i, runner: "jest" },
    { re: /^Ran\s+\d+\s+tests?\s+in\s+[\d.]+s/, runner: "pytest" },
    { re: /^=+\s+\d+\s+(?:passed|failed|error)/, runner: "pytest" },
    { re: /^\s*\d+\s+pass(?:ed|ing)?\b/i, runner: "bun/mocha" },
    { re: /^\s*\d+\s+fail(?:ed|ing)?\b/i, runner: "bun/mocha" },
    { re: /^\s*✓\s+\d+\s+tests?\s+passed/i, runner: "vitest" },
  ];
  const isTestOutput = lines.some((l) => patterns.some((p) => p.re.test(l)));
  if (!isTestOutput) return null;

  // Collect failure indicators.
  const failures: string[] = [];
  const failRe = /^\s*(?:FAIL|✗|×|✘|✖|\[FAIL\])\s+(.+)$/;
  const assertionRe = /^\s*(?:Error|AssertionError|Expected|FAIL):\s+(.+)$/i;
  for (let i = 0; i < lines.length && failures.length < 3; i++) {
    const line = lines[i]!;
    let m = line.match(failRe);
    if (!m) m = line.match(assertionRe);
    if (m) {
      const desc = m[1]!.trim();
      // If a file:line marker is on an adjacent line, attach it.
      const near = (lines[i + 1] ?? "") + " " + (lines[i - 1] ?? "");
      const loc = near.match(/([^\s:]+\.[a-z]{1,5}):(\d+)/);
      failures.push(loc ? `${desc}  (${loc[1]}:${loc[2]})` : desc);
    }
  }

  // Find the final summary line (last matching pattern line wins).
  let finalLine = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (patterns.some((p) => p.re.test(line))) {
      finalLine = line.trim();
      break;
    }
  }

  const out: string[] = [];
  if (failures.length > 0) {
    out.push(`failures (${failures.length}):`);
    for (const f of failures) out.push(`  ✗ ${f}`);
  }
  if (finalLine) out.push(finalLine);

  // Only return a summary if we actually reduced something.
  if (out.length === 0) return null;
  const summary = out.join("\n");
  if (summary.length >= stdout.length) return null;
  return summary;
}

/**
 * `tsc --noEmit` — return error count + first 3 errors with file:line.
 * Matches the standard "path(line,col): error TSxxxx: message" shape.
 */
function summarizeTsc(stdout: string): string | null {
  const lines = stdout.split("\n");
  const errorRe = /^(.+?)\((\d+),(\d+)\):\s+error\s+TS(\d+):\s+(.+)$/;
  const errors: Array<{ file: string; line: string; code: string; msg: string }> = [];
  for (const line of lines) {
    const m = line.match(errorRe);
    if (m) errors.push({ file: m[1]!, line: m[2]!, code: m[4]!, msg: m[5]! });
  }
  if (errors.length === 0) return null;
  if (errors.length <= 3 && stdout.length < 2000) return null;

  const keep = errors.slice(0, 3).map(
    (e) => `  ${e.file}:${e.line}: TS${e.code}: ${e.msg}`,
  );
  const tail = errors.length > 3 ? `  … ${errors.length - 3} more errors` : "";
  const out = [`tsc: ${errors.length} error${errors.length === 1 ? "" : "s"}`, ...keep];
  if (tail) out.push(tail);
  return out.join("\n");
}

/**
 * `npm install` / `bun install` / `yarn install` / `pnpm install` — extract
 * just the final "added N packages" / "Packages installed" line; drop all
 * per-package progress chatter.
 */
function summarizePackageInstall(stdout: string): string | null {
  if (stdout.length < 200) return null;
  const lines = stdout.split("\n");
  const signalRe = new RegExp(
    // npm:  "added 42 packages, and audited 1234 packages in 3s"
    // yarn: "Done in 4.12s." / "✨  Done in X"
    // bun:  "42 packages installed" / "Packages installed"
    // pnpm: "Progress: resolved N, reused N, downloaded N"
    "^(?:" +
      "\\s*added\\s+\\d+\\s+packages?" +
      "|\\s*changed\\s+\\d+\\s+packages?" +
      "|\\s*removed\\s+\\d+\\s+packages?" +
      "|\\s*up\\s+to\\s+date" +
      "|\\s*\\d+\\s+packages?\\s+installed" +
      "|\\s*Packages?\\s+installed" +
      "|\\s*Done\\s+in\\s+[\\d.]+s" +
      "|\\s*[✨🚀]\\s*Done\\s+in\\s+[\\d.]+s" +
      "|\\s*Progress:\\s+resolved" +
    ")",
    "i",
  );
  const kept: string[] = [];
  for (const line of lines) {
    if (signalRe.test(line)) {
      const trimmed = line.trim();
      if (trimmed && !kept.includes(trimmed)) kept.push(trimmed);
    }
  }
  if (kept.length === 0) return null;
  if (kept.join("\n").length >= stdout.length) return null;
  return kept.join("\n");
}

// ---------------------------------------------------------------------------
// Helper: flag commands whose output should flow through the LLM diff
// summarizer instead of a synchronous registry entry. bash-server can use
// this to short-circuit registry matching before invoking summarizeIfLarge.
// ---------------------------------------------------------------------------

/**
 * True if `command` is a git diff-like command whose stdout should be piped
 * through `summarizeIfLarge` with `PROMPTS.diff` when it exceeds 4 KB.
 * (Pure check — no I/O; safe to call anywhere.)
 */
export function isLargeDiffCommand(command: string): boolean {
  const t = command.trim();
  return /^git\s+(diff|show)\b/.test(t);
}

/** Byte threshold at which git diff / git show output should be LLM-summarized. */
export const DIFF_LLM_THRESHOLD_BYTES = 4 * 1024;

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

  // v1.18 high-frequency additions (token-compression-wins):
  ["git-log", summarizeGitLog],
  // Test runners — detect by output shape; the key matches the common
  // first-word invocation so findSummarizer routes correctly.
  ["jest", summarizeTestRunner],
  ["vitest", summarizeTestRunner],
  ["pytest", summarizeTestRunner],
  ["mocha", summarizeTestRunner],
  ["bun-test", summarizeTestRunner],
  ["npm-test", summarizeTestRunner],
  ["yarn-test", summarizeTestRunner],
  ["pnpm-test", summarizeTestRunner],
  // `tsc --noEmit` — match on bare `tsc` and `npx tsc`.
  ["tsc", summarizeTsc],
  ["npx-tsc", summarizeTsc],
  ["bunx-tsc", summarizeTsc],
  // Package installs — drop per-package chatter, keep the final line.
  ["npm-install", summarizePackageInstall],
  ["npm-i", summarizePackageInstall],
  ["npm-ci", summarizePackageInstall],
  ["bun-install", summarizePackageInstall],
  ["bun-i", summarizePackageInstall],
  ["yarn-install", summarizePackageInstall],
  ["pnpm-install", summarizePackageInstall],
  ["pnpm-i", summarizePackageInstall],
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
  summarizeGitLog,
  summarizeTestRunner,
  summarizeTsc,
  summarizePackageInstall,
};
