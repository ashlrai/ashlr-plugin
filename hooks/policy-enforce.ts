#!/usr/bin/env bun
/**
 * policy-enforce.ts — PreToolUse hook.
 *
 * Runs before every Edit, Write, Bash, MultiEdit call (and ashlr equivalents).
 * Fetches /policy/current (5-min in-process cache) and applies rules:
 *
 *   deny          → exit 2, writes JSON reason to stdout (blocks the tool)
 *   requireConfirm → writes permissionDecision:"ask" JSON to stdout (Claude prompts user)
 *   allow / no match → exit 0 silently (proceeds)
 *
 * Precedence: deny > requireConfirm > allow.
 *
 * Kill switch: set ASHLR_POLICY_ENFORCE=0 to disable entirely.
 *
 * Registered in hooks.json:
 *   PreToolUse matcher: Edit|Write|Bash|MultiEdit|mcp__ashlr-efficiency__ashlr__edit|mcp__ashlr-multi-edit__*
 */

import { tmpdir } from "os";
import { join } from "path";
import { minimatch } from "minimatch";
import { recordHookTiming } from "./pretooluse-common";

const hookStartedAt = Date.now();
let observedTool: string | undefined;
let outcome: "ok" | "bypass" | "block" | "error" = "ok";
process.on("exit", (code) => {
  if (outcome === "ok" && code === 2) outcome = "block";
  recordHookTiming({
    hook: "policy-enforce",
    tool: observedTool,
    durationMs: Date.now() - hookStartedAt,
    outcome,
  });
});

const token   = process.env["ASHLR_PRO_TOKEN"];
const baseUrl = process.env["ASHLR_API_URL"] ?? "https://api.ashlr.ai";
const enforce = process.env["ASHLR_POLICY_ENFORCE"] !== "0";

if (!token || !enforce) {
  process.exit(0);
}

// ---------------------------------------------------------------------------
// In-process policy cache (5-min TTL, reset on each process start — this hook
// is short-lived, so the "cache" is just a module-level variable reused within
// a single invocation; for a long-running daemon it would survive across calls)
// ---------------------------------------------------------------------------

interface PolicyRule {
  match: string;
  kind: "tool" | "path" | "shell";
  reason?: string;
}

interface PolicyRules {
  allow: PolicyRule[];
  deny: PolicyRule[];
  requireConfirm: PolicyRule[];
}

interface CachedPolicy {
  rules: PolicyRules;
  fetchedAt: number;
  etag: string;
}

// Persist cache in a temp file so multiple short-lived hook invocations share it.
// Use os.tmpdir() + path.join so this works on Windows (where /tmp/ does not
// exist and the silent failure otherwise disables policy enforcement entirely).
//
// The filename suffix is sha256(token).slice(0,16) — NOT base64url(token).
// The prior derivation leaked 12 raw bytes of the token random stream to any
// local user who could `ls /tmp`; a hash of it reveals nothing about the
// preimage while still uniquely scoping the cache per token.
const { createHash } = require("crypto") as typeof import("crypto");
const CACHE_PATH = join(
  tmpdir(),
  `.ashlr-policy-cache-${createHash("sha256").update(token).digest("hex").slice(0, 16)}.json`,
);
const TTL_MS = 5 * 60 * 1000; // 5 minutes

async function loadCachedPolicy(): Promise<CachedPolicy | null> {
  try {
    const raw = await Bun.file(CACHE_PATH).text();
    const cached = JSON.parse(raw) as CachedPolicy;
    if (Date.now() - cached.fetchedAt < TTL_MS) return cached;
  } catch {
    // Cache miss or parse error
  }
  return null;
}

async function fetchPolicy(): Promise<PolicyRules | null> {
  const cached = await loadCachedPolicy();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (cached) headers["if-none-match"] = cached.etag;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${baseUrl}/policy/current`, { headers, signal: controller.signal });
    clearTimeout(timeout);

    if (res.status === 304 && cached) return cached.rules;
    if (res.status === 404) return null; // No policy configured — allow all
    if (!res.ok) return cached?.rules ?? null;

    const data = await res.json() as { rules: PolicyRules };
    const etag = res.headers.get("etag") ?? "";
    const entry: CachedPolicy = { rules: data.rules, fetchedAt: Date.now(), etag };
    await Bun.write(CACHE_PATH, JSON.stringify(entry));
    return entry.rules;
  } catch {
    // Network error — fail open (allow) to avoid blocking all tools
    return cached?.rules ?? null;
  }
}

// ---------------------------------------------------------------------------
// Read hook input from stdin
// ---------------------------------------------------------------------------

let payload: Record<string, unknown> = {};
try {
  const raw = await Bun.stdin.text();
  if (raw.trim()) payload = JSON.parse(raw) as Record<string, unknown>;
} catch {
  process.exit(0);
}

const toolName  = (payload["tool_name"] as string | undefined) ?? "";
observedTool = toolName || undefined;
const toolInput = (payload["tool_input"] as Record<string, unknown> | undefined) ?? {};

// ---------------------------------------------------------------------------
// Build match subject strings for each rule kind
// ---------------------------------------------------------------------------

/** Returns true if the rule matches the current tool call. */
function ruleMatches(rule: PolicyRule): boolean {
  switch (rule.kind) {
    case "tool":
      // Match against tool name, e.g. "mcp__ashlr-*" or "Bash"
      return minimatch(toolName, rule.match, { nocase: true });

    case "path": {
      // Extract path arguments from tool input
      const pathArgs = [
        toolInput["file_path"],
        toolInput["path"],
        toolInput["file"],
      ].filter((v): v is string => typeof v === "string");
      return pathArgs.some((p) => minimatch(p, rule.match));
    }

    case "shell": {
      // Match against Bash command string
      const cmd = (toolInput["command"] as string | undefined) ?? "";
      // Rule like "Bash(rm *)" — extract the inner pattern if present
      const inner = rule.match.match(/^Bash\((.+)\)$/);
      const pattern = inner ? inner[1] : rule.match;
      return minimatch(cmd, pattern!) || cmd.startsWith(pattern!.replace(/\s*\*$/, "").trimEnd());
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluate rules
// ---------------------------------------------------------------------------

const rules = await fetchPolicy();

if (!rules) {
  // No policy or fetch failed. Default is allow (fail-open) so transient
  // network issues don't brick the agent. Operators with strict compliance
  // requirements can set ASHLR_POLICY_FAIL_CLOSED=1 to block all matched
  // tools when the policy endpoint is unreachable.
  if (process.env["ASHLR_POLICY_FAIL_CLOSED"] === "1") {
    process.stdout.write(
      JSON.stringify({
        type: "block",
        reason: "ashlr policy endpoint unreachable (ASHLR_POLICY_FAIL_CLOSED=1)",
      }) + "\n",
    );
    process.exit(2);
  }
  process.exit(0);
}

// Deny takes highest precedence
for (const rule of rules.deny) {
  if (ruleMatches(rule)) {
    const reason = rule.reason ?? `Blocked by policy rule: deny ${rule.kind} "${rule.match}"`;
    process.stdout.write(
      JSON.stringify({
        type: "block",
        reason,
      }) + "\n",
    );
    process.exit(2);
  }
}

// requireConfirm
for (const rule of rules.requireConfirm) {
  if (ruleMatches(rule)) {
    const reason = `Policy requires confirmation: ${rule.kind} "${rule.match}"`;
    process.stdout.write(
      JSON.stringify({
        permissionDecision: "ask",
        reason,
      }) + "\n",
    );
    process.exit(0);
  }
}

// Allow (explicit or no match) — proceed silently
process.exit(0);
