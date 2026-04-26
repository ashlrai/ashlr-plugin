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
import { logEvent } from "./_events";
import { summarizeIfLarge, PROMPTS } from "./_summarize";

// PR diffs ≥ this size are routed through the LLM summarizer (PROMPTS.diff)
// with a ~2 KB budget. Smaller diffs pass through unchanged. Chosen to catch
// 50+ file PRs (typically 40-200 KB of diff text) without paying the LLM
// roundtrip on small 1-2 file PRs.
const PR_DIFF_LLM_THRESHOLD_BYTES = 16 * 1024;
const PR_DIFF_LLM_BUDGET_BYTES = 2 * 1024;

// Cap on `gh` JSON payloads we'll attempt to parse. Real PR/issue JSON weighs
// in well under this; anything larger is pathological and parsing it would
// burn memory for no useful render.
const MAX_GH_JSON_BYTES = 4 * 1024 * 1024;

function safeParseGhJson<T>(raw: string, tool: string, kind: string): T {
  if (raw.length > MAX_GH_JSON_BYTES) {
    void logEvent("tool_error", {
      tool,
      reason: `${kind} payload ${raw.length} bytes exceeds cap`,
    });
    throw new Error(`${tool}: ${kind} payload too large (${raw.length} bytes, cap ${MAX_GH_JSON_BYTES})`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void logEvent("tool_error", {
      tool,
      reason: `malformed ${kind} JSON: ${msg}`,
    });
    throw new Error(`${tool}: malformed ${kind} JSON from gh CLI`);
  }
}

type ToolName =
  | "ashlr__pr"
  | "ashlr__issue"
  | "ashlr__pr_comment"
  | "ashlr__pr_approve"
  | "ashlr__issue_create"
  | "ashlr__issue_close";

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
    const parsed = safeParseGhJson<{ nameWithOwner?: string }>(out, "ashlr__pr", "repo view");
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

/**
 * Compress a PR diff. For diffs < PR_DIFF_LLM_THRESHOLD_BYTES, pass through
 * unchanged. For larger diffs, route through `summarizeIfLarge` with the
 * shared diff prompt and a ~2KB output budget. Falls back to snipCompact on
 * LLM failure (handled inside summarizeIfLarge).
 */
async function compressPRDiff(diff: string): Promise<string> {
  const bytes = Buffer.byteLength(diff, "utf-8");
  if (bytes < PR_DIFF_LLM_THRESHOLD_BYTES) return diff;
  const r = await summarizeIfLarge(diff, {
    toolName: "ashlr__pr",
    systemPrompt: PROMPTS.diff,
    thresholdBytes: PR_DIFF_LLM_BUDGET_BYTES,
  });
  return r.text;
}

async function renderPR(pr: PRData, mode: "summary" | "full" | "thread", diff?: string): Promise<string> {
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
    // For large diffs (>= 16 KB) route through the LLM summarizer with the
    // PROMPTS.diff prompt. For smaller diffs, keep the existing snipText path
    // (head/tail fold for < 2 KB, snipCompact for 2-16 KB).
    const diffBytes = Buffer.byteLength(diff, "utf-8");
    const rendered = diffBytes >= PR_DIFF_LLM_THRESHOLD_BYTES
      ? await compressPRDiff(diff)
      : snipText(diff);
    lines.push("");
    lines.push("diff:");
    lines.push(rendered);
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

export async function ashlrPr(input: { number: number; repo?: string; mode?: string }): Promise<string> {
  const n = Number(input.number);
  if (!Number.isFinite(n) || n <= 0) throw new Error("ashlr__pr: `number` must be a positive integer");
  const mode = (input.mode ?? "summary") as "summary" | "full" | "thread";
  if (!["summary", "full", "thread"].includes(mode)) {
    throw new Error(`ashlr__pr: invalid mode '${mode}' (expected summary|full|thread)`);
  }
  const repo = validateRepo(input.repo ?? detectRepo(), "ashlr__pr");

  const args = ["pr", "view", String(n), "--repo", repo, "--json", PR_JSON_FIELDS];
  const rawJson = runGh(args);
  const pr = safeParseGhJson<PRData>(rawJson, "ashlr__pr", "pr view");

  let diff: string | undefined;
  let rawTotal = rawJson.length;
  if (mode === "full") {
    diff = runGh(["pr", "diff", String(n), "--repo", repo]);
    rawTotal += diff.length;
  }

  const compact = await renderPR(pr, mode, diff);
  await recordSaving(rawTotal, compact.length, "ashlr__pr");
  return compact;
}

export async function ashlrIssue(input: { number: number; repo?: string; mode?: string }): Promise<string> {
  const n = Number(input.number);
  if (!Number.isFinite(n) || n <= 0) throw new Error("ashlr__issue: `number` must be a positive integer");
  const mode = (input.mode ?? "summary") as "summary" | "thread";
  if (!["summary", "thread"].includes(mode)) {
    throw new Error(`ashlr__issue: invalid mode '${mode}' (expected summary|thread)`);
  }
  const repo = validateRepo(input.repo ?? detectRepo(), "ashlr__issue");
  const args = ["issue", "view", String(n), "--repo", repo, "--json", ISSUE_JSON_FIELDS];
  const rawJson = runGh(args);
  const iss = safeParseGhJson<IssueData>(rawJson, "ashlr__issue", "issue view");
  const compact = renderIssue(iss, mode);
  await recordSaving(rawJson.length, compact.length, "ashlr__issue");
  return compact;
}

// ---------------------------------------------------------------------------
// Write-op helpers (shared across pr_comment / pr_approve / issue_* tools).
// ---------------------------------------------------------------------------

/**
 * Guard every write op. Confirmation is now required by default — a
 * prompt-injected caller can otherwise exfiltrate data into an
 * attacker-controlled issue body, or approve/close PRs impersonating the
 * user via the locally-authenticated `gh`. Operators who want the previous
 * silent behavior can set ASHLR_REQUIRE_GH_CONFIRM=0 explicitly.
 *
 * Approve is held to an even stricter bar: confirm is always mandatory,
 * independent of the env var, because mistakenly approving a PR is a
 * harder-to-unwind action than commenting.
 */
function enforceConfirm(tool: ToolName, confirm: unknown): void {
  const envVal = process.env.ASHLR_REQUIRE_GH_CONFIRM;
  const confirmRequired =
    tool === "ashlr__pr_approve" ? true : envVal !== "0";
  if (confirmRequired && confirm !== true) {
    throw new Error(
      `${tool}: write ops require explicit confirmation. Pass { confirm: true }. (Set ASHLR_REQUIRE_GH_CONFIRM=0 to disable for non-approve tools.)`,
    );
  }
}

/**
 * Refuse a write op against a repo that does not match the current working
 * directory's detected git remote, unless the caller sets
 * ASHLR_GH_ALLOW_ANY_REPO=1 (explicit override for the rare cross-repo case).
 * Closes the "prompt-injected exfil via issue body in attacker-owned repo"
 * path — a prompt-injected caller trying to post to `attacker/drop` from a
 * user's legitimate repo now hits a hard refusal.
 */
function enforceRepoScope(tool: ToolName, repo: string): void {
  if (process.env.ASHLR_GH_ALLOW_ANY_REPO === "1") return;
  let detected: string;
  try { detected = detectRepo(); } catch { return; } // no remote — leave to the caller's explicit repo
  if (detected.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(
      `${tool}: refused write to '${repo}' — only the cwd's detected repo ('${detected}') is allowed. Set ASHLR_GH_ALLOW_ANY_REPO=1 to override.`,
    );
  }
}

function requireString(tool: ToolName, field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${tool}: \`${field}\` is required and must be a non-empty string`);
  }
  return value;
}

/** Resolve `pr: number | "current"` to a concrete PR number using gh. */
function resolvePrNumber(input: number | string, repo: string, tool: ToolName): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) {
      throw new Error(`${tool}: \`pr\` must be a positive integer or "current"`);
    }
    return input;
  }
  if (input === "current") {
    // gh pr view with no argument uses the current branch; json omits branch ambiguity.
    const out = runGh(["pr", "view", "--repo", repo, "--json", "number,author"]);
    const parsed = safeParseGhJson<{ number?: number; author?: { login?: string } }>(
      out,
      tool,
      "pr view (current)",
    );
    if (typeof parsed.number !== "number") {
      throw new Error(`${tool}: could not resolve current branch's PR (is there one open?)`);
    }
    return parsed.number;
  }
  throw new Error(`${tool}: \`pr\` must be a positive integer or "current"`);
}

/** Resolve the current-viewer's login, used for self-approval check. */
function currentViewerLogin(tool: ToolName): string | undefined {
  try {
    const out = runGh(["api", "user", "--jq", ".login"]);
    const login = out.trim();
    return login || undefined;
  } catch (err) {
    // Non-fatal: we'd rather skip the self-approval check than fail the call
    // if `gh api user` misbehaves. Caller can still hit the github-side guard.
    void logEvent("tool_error", {
      tool,
      reason: `viewer lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return undefined;
  }
}

/** Fetch `author.login` for a PR — used only for the self-approval guard. */
function prAuthorLogin(prNum: number, repo: string, tool: ToolName): string | undefined {
  try {
    const out = runGh(["pr", "view", String(prNum), "--repo", repo, "--json", "author"]);
    const parsed = safeParseGhJson<{ author?: { login?: string } }>(out, tool, "pr view (author)");
    return parsed.author?.login;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Write-op 1: post a comment on a PR
// ---------------------------------------------------------------------------

export async function ashlrPrComment(input: {
  pr: number | string;
  body: string;
  repo?: string;
  confirm?: boolean;
}): Promise<string> {
  enforceConfirm("ashlr__pr_comment", input.confirm);
  const body = requireString("ashlr__pr_comment", "body", input.body);
  const repo = validateRepo(input.repo ?? detectRepo(), "ashlr__pr_comment");
  enforceRepoScope("ashlr__pr_comment", repo);
  const prNum = resolvePrNumber(input.pr, repo, "ashlr__pr_comment");

  // `gh pr comment <n> --body <body> --repo <repo>` prints the new comment URL on success.
  const out = runGh(["pr", "comment", String(prNum), "--body", body, "--repo", repo]);
  const url = out.trim().split("\n").find((l) => l.startsWith("http")) ?? out.trim();
  const compact = `commented on PR #${prNum} (${repo}) · ${url}`;
  await recordSaving(out.length, compact.length, "ashlr__pr_comment");
  return compact;
}

// ---------------------------------------------------------------------------
// Write-op 2: approve a PR (with optional comment body)
// ---------------------------------------------------------------------------

export async function ashlrPrApprove(input: {
  pr: number | string;
  body?: string;
  repo?: string;
  confirm?: boolean;
}): Promise<string> {
  enforceConfirm("ashlr__pr_approve", input.confirm);
  const repo = validateRepo(input.repo ?? detectRepo(), "ashlr__pr_approve");
  enforceRepoScope("ashlr__pr_approve", repo);
  const prNum = resolvePrNumber(input.pr, repo, "ashlr__pr_approve");

  // Self-approval guard: only enforced when we can cheaply determine both
  // viewer and author. GitHub will also reject this server-side, but a
  // caller-side error is faster + clearer.
  const viewer = currentViewerLogin("ashlr__pr_approve");
  const author = prAuthorLogin(prNum, repo, "ashlr__pr_approve");
  if (viewer && author && viewer === author) {
    throw new Error(
      `ashlr__pr_approve: cannot approve your own PR (#${prNum} authored by ${author})`,
    );
  }

  const args = ["pr", "review", String(prNum), "--approve", "--repo", repo];
  if (typeof input.body === "string" && input.body.trim() !== "") {
    args.push("--body", input.body);
  }
  const out = runGh(args);
  const compact = `approved PR #${prNum} (${repo})${input.body ? ' · "' + cap(flat(input.body), 80) + '"' : ""}`;
  await recordSaving(out.length || compact.length, compact.length, "ashlr__pr_approve");
  return compact;
}

// ---------------------------------------------------------------------------
// Write-op 3: create a new issue
// ---------------------------------------------------------------------------

export async function ashlrIssueCreate(input: {
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
  repo?: string;
  confirm?: boolean;
}): Promise<string> {
  enforceConfirm("ashlr__issue_create", input.confirm);
  const title = requireString("ashlr__issue_create", "title", input.title);
  const body = requireString("ashlr__issue_create", "body", input.body);
  const repo = validateRepo(input.repo ?? detectRepo(), "ashlr__issue_create");
  enforceRepoScope("ashlr__issue_create", repo);

  const args = ["issue", "create", "--title", title, "--body", body, "--repo", repo];
  if (Array.isArray(input.labels) && input.labels.length) {
    args.push("--label", input.labels.join(","));
  }
  if (Array.isArray(input.assignees) && input.assignees.length) {
    args.push("--assignee", input.assignees.join(","));
  }

  // `gh issue create` prints the new issue URL on success.
  const out = runGh(args);
  const url = out.trim().split("\n").find((l) => l.startsWith("http")) ?? out.trim();
  const numMatch = url.match(/\/issues\/(\d+)/);
  const num = numMatch ? Number(numMatch[1]) : undefined;
  const compact = `created issue${num ? " #" + num : ""} (${repo}) · ${url}`;
  await recordSaving(out.length, compact.length, "ashlr__issue_create");
  return compact;
}

// ---------------------------------------------------------------------------
// Write-op 4: close an issue (optionally comment + reason)
// ---------------------------------------------------------------------------

export async function ashlrIssueClose(input: {
  issue: number;
  comment?: string;
  reason?: string;
  repo?: string;
  confirm?: boolean;
}): Promise<string> {
  enforceConfirm("ashlr__issue_close", input.confirm);
  const n = Number(input.issue);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("ashlr__issue_close: `issue` must be a positive integer");
  }
  const repo = validateRepo(input.repo ?? detectRepo(), "ashlr__issue_close");
  enforceRepoScope("ashlr__issue_close", repo);

  const args = ["issue", "close", String(n), "--repo", repo];
  if (typeof input.comment === "string" && input.comment.trim() !== "") {
    args.push("--comment", input.comment);
  }
  if (typeof input.reason === "string" && input.reason.trim() !== "") {
    if (!["completed", "not_planned"].includes(input.reason)) {
      throw new Error(
        `ashlr__issue_close: invalid reason '${input.reason}' (expected completed|not_planned)`,
      );
    }
    args.push("--reason", input.reason);
  }

  const out = runGh(args);
  const compact = `closed issue #${n} (${repo})${input.reason ? " · " + input.reason : ""}${input.comment ? ' · "' + cap(flat(input.comment), 80) + '"' : ""}`;
  await recordSaving(out.length || compact.length, compact.length, "ashlr__issue_close");
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
    {
      name: "ashlr__pr_comment",
      description:
        "Post a comment on a GitHub PR. Pass pr:\"current\" to target the PR for the checked-out branch. Returns the new comment URL.",
      inputSchema: {
        type: "object",
        properties: {
          pr:      { description: "PR number or the string \"current\" to target the current branch's PR", oneOf: [{ type: "number" }, { type: "string", enum: ["current"] }] },
          body:    { type: "string", description: "Comment body (markdown supported)" },
          repo:    { type: "string", description: "owner/repo (default: auto-detect from cwd git remote)" },
          confirm: { type: "boolean", description: "Required when ASHLR_REQUIRE_GH_CONFIRM=1" },
        },
        required: ["pr", "body"],
      },
    },
    {
      name: "ashlr__pr_approve",
      description:
        "Approve a GitHub PR with an optional review body. Refuses to approve your own PR. Pass pr:\"current\" to target the PR for the checked-out branch.",
      inputSchema: {
        type: "object",
        properties: {
          pr:      { description: "PR number or the string \"current\" to target the current branch's PR", oneOf: [{ type: "number" }, { type: "string", enum: ["current"] }] },
          body:    { type: "string", description: "Optional review comment body" },
          repo:    { type: "string", description: "owner/repo (default: auto-detect from cwd git remote)" },
          confirm: { type: "boolean", description: "Required when ASHLR_REQUIRE_GH_CONFIRM=1" },
        },
        required: ["pr"],
      },
    },
    {
      name: "ashlr__issue_create",
      description:
        "Create a new GitHub issue with title + body and optional labels/assignees. Returns the new issue number and URL.",
      inputSchema: {
        type: "object",
        properties: {
          title:     { type: "string", description: "Issue title" },
          body:      { type: "string", description: "Issue body (markdown supported)" },
          labels:    { type: "array", items: { type: "string" }, description: "Optional label names to apply" },
          assignees: { type: "array", items: { type: "string" }, description: "Optional GitHub logins to assign" },
          repo:      { type: "string", description: "owner/repo (default: auto-detect from cwd git remote)" },
          confirm:   { type: "boolean", description: "Required when ASHLR_REQUIRE_GH_CONFIRM=1" },
        },
        required: ["title", "body"],
      },
    },
    {
      name: "ashlr__issue_close",
      description:
        "Close a GitHub issue with an optional closing comment and reason (completed|not_planned).",
      inputSchema: {
        type: "object",
        properties: {
          issue:   { type: "number", description: "Issue number" },
          comment: { type: "string", description: "Optional closing comment" },
          reason:  { type: "string", enum: ["completed", "not_planned"], description: "Optional close reason" },
          repo:    { type: "string", description: "owner/repo (default: auto-detect from cwd git remote)" },
          confirm: { type: "boolean", description: "Required when ASHLR_REQUIRE_GH_CONFIRM=1" },
        },
        required: ["issue"],
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
      case "ashlr__pr_comment": {
        const text = await ashlrPrComment(
          args as { pr: number | string; body: string; repo?: string; confirm?: boolean },
        );
        return { content: [{ type: "text", text }] };
      }
      case "ashlr__pr_approve": {
        const text = await ashlrPrApprove(
          args as { pr: number | string; body?: string; repo?: string; confirm?: boolean },
        );
        return { content: [{ type: "text", text }] };
      }
      case "ashlr__issue_create": {
        const text = await ashlrIssueCreate(
          args as {
            title: string;
            body: string;
            labels?: string[];
            assignees?: string[];
            repo?: string;
            confirm?: boolean;
          },
        );
        return { content: [{ type: "text", text }] };
      }
      case "ashlr__issue_close": {
        const text = await ashlrIssueClose(
          args as {
            issue: number;
            comment?: string;
            reason?: string;
            repo?: string;
            confirm?: boolean;
          },
        );
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

if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
