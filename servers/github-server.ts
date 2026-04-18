#!/usr/bin/env bun
/**
 * ashlr-github MCP server.
 *
 * Exposes two read-only tools that compress GitHub PR / issue API output so
 * reviewer agents don't burn 10-30K tokens on raw `gh` JSON dumps:
 *
 *   - ashlr__pr     — compact PR header, reviews, unresolved comments, checks
 *   - ashlr__issue  — compact issue header, body, and comment list
 *
 * Never mutates. Shells out to `gh` and times out at 15s per call. Savings
 * are persisted to the shared ~/.ashlr/stats.json.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawnSync } from "child_process";

import { snipCompact } from "@ashlr/core-efficiency/compression";
import type { Message } from "@ashlr/core-efficiency";
import { recordSaving as recordSavingCore } from "./_stats";

type ToolName = "ashlr__pr" | "ashlr__issue";

async function recordSaving(rawChars: number, compactChars: number, tool: ToolName): Promise<void> {
  await recordSavingCore(rawChars, compactChars, tool);
}

// ---------------------------------------------------------------------------
// gh runner
// ---------------------------------------------------------------------------

const GH_TIMEOUT_MS = 15_000;

function ghOnPath(): boolean {
  // Bun.which is cross-platform and avoids shelling out to `sh`.
  if (typeof (globalThis as { Bun?: { which(b: string): string | null } }).Bun !== "undefined") {
    return !!(globalThis as { Bun: { which(b: string): string | null } }).Bun.which("gh");
  }
  // Fallback for non-Bun runtimes.
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["gh"], {
    encoding: "utf-8",
  });
  return which.status === 0 && !!which.stdout.trim();
}

/** Run `gh` with given args. Throws on non-zero exit or missing binary. */
function runGh(args: string[], cwd?: string): string {
  if (!ghOnPath()) {
    throw new Error(
      "gh CLI not found on PATH. Install with `brew install gh` (macOS) or see https://cli.github.com",
    );
  }
  const res = spawnSync("gh", args, {
    encoding: "utf-8",
    timeout: GH_TIMEOUT_MS,
    cwd,
    // Inherit env so gh picks up GH_TOKEN / credential helpers.
    env: process.env,
  });
  if (res.status !== 0) {
    const err = (res.stderr || "").trim();
    // Don't leak a token if gh ever echoed one — just show the first line.
    const firstLine = err.split("\n")[0] ?? "";
    if (/not logged in|authentication required/i.test(err)) {
      throw new Error("gh not authenticated. Run `gh auth login` first.");
    }
    throw new Error(`gh ${args[0]} failed: ${firstLine || "exit " + res.status}`);
  }
  return res.stdout;
}

// ---------------------------------------------------------------------------
// Repo detection
// ---------------------------------------------------------------------------

function detectRepo(cwd = process.cwd()): string {
  // Try `gh repo view` first (works even when remote is a short form).
  try {
    const out = runGh(["repo", "view", "--json", "nameWithOwner"], cwd);
    const parsed = JSON.parse(out) as { nameWithOwner?: string };
    if (parsed.nameWithOwner) return parsed.nameWithOwner;
  } catch { /* fall through */ }

  // Fallback: parse `git remote get-url origin`.
  const git = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf-8" });
  if (git.status === 0 && git.stdout) {
    const url = git.stdout.trim();
    // git@github.com:owner/repo(.git)?  OR  https://github.com/owner/repo(.git)?
    const m = url.match(/github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/);
    if (m) return m[1]!;
  }
  throw new Error(
    "Could not detect GitHub repo from cwd. Pass `repo: \"owner/name\"` explicitly.",
  );
}

// ---------------------------------------------------------------------------
// Compression helper — wrap string through snipCompact using the tool_result
// trick (same approach efficiency-server uses). Keeps compression logic
// consolidated in core-efficiency instead of re-implementing head/tail here.
// ---------------------------------------------------------------------------

function snipText(s: string, minLen = 500): string {
  if (s.length <= minLen) return s;
  // snipCompact's internal threshold is 2KB. For bodies/comments just over our
  // callsite threshold we still want compression, so do a simple head/tail fold
  // ourselves in the 500–2048 range; above 2KB defer to snipCompact.
  if (s.length <= 2048) {
    const keep = 250;
    return s.slice(0, keep) + `\n[... ${s.length - 2 * keep} chars elided ...]\n` + s.slice(-keep);
  }
  const msgs: Message[] = [
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "ashlr-gh", content: s }],
    },
  ];
  const out = snipCompact(msgs);
  const block = (out[0]!.content as { type: string; content: string }[])[0]!;
  return (block as { content: string }).content;
}

/** Compact a string to at most `max` chars with a trailing ellipsis marker. */
function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** One-line flattening of whitespace for table-style rendering. */
function flat(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Types we care about in the gh JSON (partial — only fields we read).
// ---------------------------------------------------------------------------

interface Review {
  author?: { login?: string };
  state?: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | PENDING | DISMISSED
  body?: string;
  submittedAt?: string;
}
interface PRComment {
  author?: { login?: string };
  body?: string;
  path?: string;
  line?: number;
  createdAt?: string;
  isResolved?: boolean;
}
interface CheckRun {
  name?: string;
  status?: string;
  conclusion?: string; // SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | ACTION_REQUIRED
  state?: string;      // status-context style (older)
}
interface PRFile { path?: string; additions?: number; deletions?: number }
interface PRData {
  number: number;
  title: string;
  state: string;
  author?: { login?: string };
  createdAt?: string;
  updatedAt?: string;
  mergeable?: string;
  reviewDecision?: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  baseRefName?: string;
  headRefName?: string;
  body?: string;
  labels?: Array<{ name?: string }>;
  reviews?: Review[];
  comments?: PRComment[];
  files?: PRFile[];
  statusCheckRollup?: CheckRun[];
}

interface IssueComment { author?: { login?: string }; body?: string; createdAt?: string }
interface IssueData {
  number: number;
  title: string;
  state: string;
  author?: { login?: string };
  createdAt?: string;
  updatedAt?: string;
  body?: string;
  labels?: Array<{ name?: string }>;
  comments?: IssueComment[];
}

// ---------------------------------------------------------------------------
// PR renderer
// ---------------------------------------------------------------------------

function shortDate(iso?: string): string {
  if (!iso) return "?";
  return iso.slice(0, 10);
}

function decisionBadge(decision?: string, reviews?: Review[]): string {
  // reviewDecision can be null for REVIEW_REQUIRED when no one's reviewed yet;
  // when present it's the authoritative signal.
  if (decision === "APPROVED") return "APPROVED";
  if (decision === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
  if (decision === "REVIEW_REQUIRED") return "REVIEW_REQUIRED";
  // Fall back to review shape: if at least one COMMENTED and no approval/changes,
  // call it "COMMENTED". Otherwise "no-decision".
  const states = (reviews ?? []).map((r) => r.state).filter(Boolean);
  if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (states.includes("APPROVED")) return "APPROVED";
  if (states.includes("COMMENTED")) return "COMMENTED";
  return "REVIEW_REQUIRED";
}

function summarizeChecks(rollup?: CheckRun[]): string {
  if (!rollup || rollup.length === 0) return "checks: (none)";
  let pass = 0;
  let fail = 0;
  let pending = 0;
  const failures: string[] = [];
  for (const c of rollup) {
    const conc = (c.conclusion || c.state || "").toUpperCase();
    if (conc === "SUCCESS" || conc === "NEUTRAL" || conc === "SKIPPED") pass++;
    else if (conc === "FAILURE" || conc === "TIMED_OUT" || conc === "ACTION_REQUIRED" || conc === "CANCELLED" || conc === "ERROR") {
      fail++;
      if (c.name) failures.push(c.name);
    } else {
      pending++;
    }
  }
  const parts: string[] = [];
  if (pass) parts.push(`✓ ${pass} pass`);
  if (fail) {
    const fnames = failures.slice(0, 3).join(", ") + (failures.length > 3 ? "…" : "");
    parts.push(`✗ ${fail} fail (${fnames})`);
  }
  if (pending) parts.push(`⋯ ${pending} pending`);
  return "checks: " + (parts.join(" · ") || "(none)");
}

function renderPR(pr: PRData, mode: "summary" | "full" | "thread", diff?: string): string {
  const lines: string[] = [];
  const author = pr.author?.login ?? "?";
  const decision = decisionBadge(pr.reviewDecision, pr.reviews);
  const lbls = (pr.labels ?? []).map((l) => l.name).filter(Boolean).join(", ");

  // Header row — dense, one line.
  lines.push(
    `PR #${pr.number} · ${pr.state} · ${decision} · by ${author} · ${shortDate(pr.createdAt)} → ${shortDate(pr.updatedAt)} · +${pr.additions ?? 0} −${pr.deletions ?? 0} · ${pr.changedFiles ?? 0} files${pr.mergeable ? " · mergeable:" + pr.mergeable : ""}`,
  );
  lines.push(`title: ${pr.title}`);
  lines.push(`branch: ${pr.headRefName ?? "?"} → ${pr.baseRefName ?? "?"}`);
  if (lbls) lines.push(`labels: ${lbls}`);

  if (mode !== "thread") {
    const body = flat(pr.body ?? "");
    if (body) lines.push(`body: ${cap(body, 300)}`);
  }

  // Reviews (ordered chronologically; one line each).
  const reviews = (pr.reviews ?? []).filter((r) => r.state && r.state !== "PENDING");
  if (reviews.length) {
    lines.push(`reviews (${reviews.length}):`);
    for (const r of reviews) {
      const who = r.author?.login ?? "?";
      const st = r.state ?? "?";
      const snippet = cap(flat(r.body ?? ""), 80);
      lines.push(`  · ${who} · ${st}${snippet ? ' · "' + snippet + '"' : ""}`);
    }
  }

  // Unresolved review comments (inline comments). `gh pr view` returns top-level
  // discussion comments as `comments`; for inline we rely on body-less review
  // comments that show up here with `path`/`line`. Respect `isResolved` when set.
  const comments = (pr.comments ?? []).filter((c) => c.isResolved !== true);
  if (comments.length) {
    const label = mode === "thread" ? "comments" : "unresolved comments";
    lines.push(`${label} (${comments.length}):`);
    const take = mode === "thread" ? comments : comments.slice(0, 10);
    for (const c of take) {
      const who = c.author?.login ?? "?";
      const where = c.path ? `${c.path}${c.line ? ":" + c.line : ""}` : "";
      const snippet = cap(flat(c.body ?? ""), 80);
      lines.push(`  · ${who}${where ? " · " + where : ""}${snippet ? ' · "' + snippet + '"' : ""}`);
    }
    if (mode !== "thread" && comments.length > 10) {
      lines.push(`  · (+${comments.length - 10} more — pass mode:"thread" to see all)`);
    }
  }

  // Checks (always; they're the highest-signal compression win).
  lines.push(summarizeChecks(pr.statusCheckRollup));

  if (mode === "full" && diff !== undefined) {
    const snipped = snipText(diff);
    lines.push("");
    lines.push("diff:");
    lines.push(snipped);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Issue renderer
// ---------------------------------------------------------------------------

function renderIssue(iss: IssueData, mode: "summary" | "thread"): string {
  const lines: string[] = [];
  const author = iss.author?.login ?? "?";
  const lbls = (iss.labels ?? []).map((l) => l.name).filter(Boolean).join(", ");
  lines.push(
    `Issue #${iss.number} · ${iss.state} · by ${author} · ${shortDate(iss.createdAt)} → ${shortDate(iss.updatedAt)}`,
  );
  lines.push(`title: ${iss.title}`);
  if (lbls) lines.push(`labels: ${lbls}`);

  const body = iss.body ?? "";
  if (body) {
    const rendered = body.length > 500 ? snipText(body) : body;
    lines.push("body:");
    lines.push(rendered);
  }

  const comments = iss.comments ?? [];
  if (comments.length) {
    lines.push(`comments (${comments.length}):`);
    if (mode === "thread") {
      for (const c of comments) {
        const who = c.author?.login ?? "?";
        const when = shortDate(c.createdAt);
        const body = c.body ?? "";
        const rendered = body.length > 500 ? snipText(body) : body;
        lines.push(`  — ${who} · ${when}`);
        for (const l of rendered.split("\n")) lines.push(`    ${l}`);
      }
    } else {
      for (const c of comments.slice(0, 10)) {
        const who = c.author?.login ?? "?";
        const snippet = cap(flat(c.body ?? ""), 100);
        lines.push(`  · ${who} · "${snippet}"`);
      }
      if (comments.length > 10) {
        lines.push(`  · (+${comments.length - 10} more — pass mode:"thread" to see all)`);
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool impls
// ---------------------------------------------------------------------------

const PR_JSON_FIELDS =
  "number,title,state,author,createdAt,updatedAt,mergeable,reviewDecision,additions,deletions,changedFiles,baseRefName,headRefName,body,labels,reviews,comments,files,statusCheckRollup";

const ISSUE_JSON_FIELDS =
  "number,title,state,author,createdAt,updatedAt,body,labels,comments";

// Guard against argv-injection: `gh` accepts many flag-like positionals
// (e.g. `--config path`), so we require the strict owner/name shape.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function validateRepo(repo: string, tool: string): string {
  if (!REPO_RE.test(repo)) {
    throw new Error(`${tool}: repo must match 'owner/name' (got '${repo}')`);
  }
  return repo;
}

async function ashlrPr(input: { number: number; repo?: string; mode?: string }): Promise<string> {
  const n = Number(input.number);
  if (!Number.isFinite(n) || n <= 0) throw new Error("ashlr__pr: `number` must be a positive integer");
  const mode = (input.mode ?? "summary") as "summary" | "full" | "thread";
  if (!["summary", "full", "thread"].includes(mode)) {
    throw new Error(`ashlr__pr: invalid mode '${mode}' (expected summary|full|thread)`);
  }
  const repo = validateRepo(input.repo ?? detectRepo(), "ashlr__pr");

  const args = ["pr", "view", String(n), "--repo", repo, "--json", PR_JSON_FIELDS];
  const rawJson = runGh(args);
  const pr = JSON.parse(rawJson) as PRData;

  let diff: string | undefined;
  let rawTotal = rawJson.length;
  if (mode === "full") {
    diff = runGh(["pr", "diff", String(n), "--repo", repo]);
    rawTotal += diff.length;
  }

  const compact = renderPR(pr, mode, diff);
  await recordSaving(rawTotal, compact.length, "ashlr__pr");
  return compact;
}

async function ashlrIssue(input: { number: number; repo?: string; mode?: string }): Promise<string> {
  const n = Number(input.number);
  if (!Number.isFinite(n) || n <= 0) throw new Error("ashlr__issue: `number` must be a positive integer");
  const mode = (input.mode ?? "summary") as "summary" | "thread";
  if (!["summary", "thread"].includes(mode)) {
    throw new Error(`ashlr__issue: invalid mode '${mode}' (expected summary|thread)`);
  }
  const repo = validateRepo(input.repo ?? detectRepo(), "ashlr__issue");
  const args = ["issue", "view", String(n), "--repo", repo, "--json", ISSUE_JSON_FIELDS];
  const rawJson = runGh(args);
  const iss = JSON.parse(rawJson) as IssueData;
  const compact = renderIssue(iss, mode);
  await recordSaving(rawJson.length, compact.length, "ashlr__issue");
  return compact;
}

// ---------------------------------------------------------------------------
// MCP wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ashlr-github", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ashlr__pr",
      description:
        "Fetch a GitHub PR and return a compact review-ready summary (header, reviews, unresolved comments, status checks). Read-only — never approves, comments, or merges. Saves 60-90% of the tokens a raw `gh pr view` dump would cost.",
      inputSchema: {
        type: "object",
        properties: {
          number: { type: "number", description: "PR number" },
          repo:   { type: "string", description: "owner/repo (default: auto-detect from cwd git remote)" },
          mode:   { type: "string", description: "'summary' (default: decisions + unresolved + checks) | 'full' (adds diff summary) | 'thread' (just comments)" },
        },
        required: ["number"],
      },
    },
    {
      name: "ashlr__issue",
      description:
        "Fetch a GitHub issue and return a compact header + body + comment list. In 'thread' mode, each comment is rendered with snipCompact on > 500 char bodies. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          number: { type: "number", description: "Issue number" },
          repo:   { type: "string", description: "owner/repo (default: auto-detect from cwd git remote)" },
          mode:   { type: "string", description: "'summary' (default) | 'thread' (full comments with snipCompact on each)" },
        },
        required: ["number"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case "ashlr__pr": {
        const text = await ashlrPr(args as { number: number; repo?: string; mode?: string });
        return { content: [{ type: "text", text }] };
      }
      case "ashlr__issue": {
        const text = await ashlrIssue(args as { number: number; repo?: string; mode?: string });
        return { content: [{ type: "text", text }] };
      }
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `ashlr error: ${message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
