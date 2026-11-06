/** Shared formatting and ripgrep resolution for legacy and current efficiency handlers. */
import { type Message, snipCompact } from "@ashlr/core-efficiency";
import type { LifetimeBucket, SessionBucket } from "./_stats";
import { costFor } from "./_pricing";

/**
 * File extensions treated as code for the line-number-preservation path.
 * When ashlr__read returns a snipCompact-truncated view of one of these files,
 * every preserved line is prefixed with its original line number so Claude can
 * cite `file:line` accurately even across the elided middle.
 */
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".kts",
  ".rb", ".php", ".swift", ".cs", ".scala", ".cpp", ".c", ".h", ".hpp",
  ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".graphql", ".proto", ".css", ".scss", ".html", ".vue", ".svelte",
]);

export function isCodeFile(path: string): boolean {
  const m = path.match(/\.[a-zA-Z0-9]+$/);
  if (!m) return false;
  return CODE_EXTENSIONS.has(m[0].toLowerCase());
}

/**
 * Prepend every line with its 1-based line number + ": " so that head/tail
 * fragments surviving snipCompact still carry positional information. Line
 * numbers use right-justified padding so alignment stays consistent across
 * the file (cheap visual affordance when Claude reads the output).
 */
export function numberCodeLines(source: string): string {
  const lines = source.split("\n");
  const pad = String(lines.length).length;
  return lines.map((line, i) => `${String(i + 1).padStart(pad, " ")}: ${line}`).join("\n");
}

/** Compact already-rendered file content without losing its original line labels. */
export function compactReadContent(renderedContent: string): string {
  const msgs: Message[] = [{
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "ashlr-read", content: renderedContent }],
  }];
  const compact = snipCompact(msgs);
  return (compact[0]!.content as { content: string }[])[0]!.content;
}

export function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || !Number.isFinite(ms)) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${rm}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

export function fmtCost(tokens: number): string {
  const c = costFor(tokens);
  if (c < 0.01) return `≈ $${c.toFixed(4)}`;
  return `≈ $${c.toFixed(2)}`;
}

function bar(value: number, max: number, width = 12): string {
  if (max <= 0 || value <= 0) return "";
  const n = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return "█".repeat(n);
}

function pct(value: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

function lastNDays(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Keep legacy and current reports aligned without sharing their distinct headers/extras. */
export function renderToolAndDaySections(session: SessionBucket, lifetime: LifetimeBucket): string[] {
  const lines: string[] = [];
  // By tool (session) - iterate whatever tools actually fired this session.
  lines.push("by tool (session):");
  const entries = Object.entries(session.byTool)
    .map(([name, pt]) => ({ name, calls: pt.calls, tokensSaved: pt.tokensSaved }))
    .filter((e) => e.calls > 0 || e.tokensSaved > 0)
    .sort((a, b) => b.tokensSaved - a.tokensSaved);
  if (entries.length === 0) {
    lines.push("  (no calls yet this session)");
  } else {
    const maxTok = Math.max(...entries.map((e) => e.tokensSaved), 1);
    const totalTok = entries.reduce((s, e) => s + e.tokensSaved, 0);
    for (const e of entries) {
      const name = e.name.padEnd(14);
      const calls = `${e.calls} call${e.calls === 1 ? " " : "s"}`.padEnd(10);
      const tok = `${e.tokensSaved.toLocaleString()} tok`.padEnd(13);
      lines.push(`  ${name}${calls}${tok}${bar(e.tokensSaved, maxTok).padEnd(13)}${pct(e.tokensSaved, totalTok)}`);
    }
  }
  lines.push("");

  // Last 7 days
  lines.push("last 7 days:");
  const days = lastNDays(7);
  const dayVals = days.map((d) => ({ d, v: lifetime.byDay[d]?.tokensSaved ?? 0 }));
  const maxDay = Math.max(...dayVals.map((x) => x.v), 1);
  for (const { d, v } of dayVals) {
    const label = d.slice(5); // MM-DD
    const b = v === 0 ? "(quiet)     " : bar(v, maxDay, 20).padEnd(20);
    const val = v === 0 ? "       0" : v.toLocaleString();
    lines.push(`  ${label}  ${b}  ${val}`);
  }
  lines.push("");

  // Last 30 days rollup. The 7-day view above shows *shape*; this block shows
  // the *totals* - calls, tokens, dollars - plus the single best day. They're
  // complementary: sparkline answers "when did I work?", rollup answers "how
  // much did I save?".
  lines.push("last 30 days:");
  const monthDays = lastNDays(30);
  const activeEntries = monthDays
    .map((d) => ({ d, entry: lifetime.byDay[d] }))
    .filter((x) => x.entry && (x.entry.calls > 0 || x.entry.tokensSaved > 0)) as Array<{
      d: string;
      entry: { calls: number; tokensSaved: number };
    }>;

  // Require at least 2 distinct active days before claiming a "monthly" rollup;
  // otherwise the number is just "today" dressed up as a month and misleading.
  if (activeEntries.length < 2) {
    lines.push("  (not enough history yet \u2014 come back in a few weeks)");
  } else {
    const totalCalls = activeEntries.reduce((s, x) => s + x.entry.calls, 0);
    const totalTok = activeEntries.reduce((s, x) => s + x.entry.tokensSaved, 0);
    const best = activeEntries.reduce((a, b) => (b.entry.tokensSaved > a.entry.tokensSaved ? b : a), activeEntries[0]!);
    lines.push(`  calls     ${totalCalls.toLocaleString()}`);
    lines.push(`  saved     ${totalTok.toLocaleString()} tok   ${fmtCost(totalTok)}`);
    lines.push(
      `  best day  ${best.d}    ·  ${best.entry.tokensSaved.toLocaleString()} tok   ·  ${best.entry.calls} call${best.entry.calls === 1 ? "" : "s"}`,
    );
  }

  return lines;
}

/**
 * Resolve rg via Bun.which (walks PATH and common Homebrew locations). Shell
 * aliases like Claude Code's own rg wrapper don't resolve under spawn, so we
 * need the actual binary. Returns "rg" as last resort so spawn can at least
 * surface a useful error.
 */
export function resolveRg(): string {
  return (
    (typeof (globalThis as { Bun?: { which(bin: string): string | null } }).Bun !== "undefined"
      ? (globalThis as { Bun: { which(bin: string): string | null } }).Bun.which("rg")
      : null) ??
    ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"].find((p) => {
      try {
        require("fs").accessSync(p);
        return true;
      } catch {
        return false;
      }
    }) ??
    "rg"
  );
}

