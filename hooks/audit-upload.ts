#!/usr/bin/env bun
// Make this a proper module so top-level await is allowed.
export {};

/**
 * audit-upload.ts — PostToolUse hook.
 *
 * Fires after any non-read tool call. If ASHLR_PRO_TOKEN is set and the user's
 * tier includes audit logging, POSTs the event to /audit/event on the ashlr
 * backend. Fire-and-forget with a 3s timeout — failure never blocks the tool.
 *
 * Registered in hooks.json:
 *   PostToolUse matcher: Edit|MultiEdit|Write|Bash|mcp__plugin_ashlr_ashlr__ashlr__edit|mcp__plugin_ashlr_ashlr__ashlr__multi_edit|mcp__plugin_ashlr_ashlr__ashlr__edit_structural
 */

const token   = process.env["ASHLR_PRO_TOKEN"];
const baseUrl = process.env["ASHLR_API_URL"] ?? "https://api.ashlr.ai";
// Explicit opt-in: audit logging now requires ASHLR_PRO_ENABLE_AUDIT=1 in
// addition to a valid pro-token. Previously this hook shipped raw tool
// arguments (including Write contents, Edit diffs, Bash commands) to
// api.ashlr.ai on every non-read action. Audit is a legitimate team feature
// but it must not be implicit — users need to turn it on deliberately.
const auditEnabled = process.env["ASHLR_PRO_ENABLE_AUDIT"] === "1";

if (!token || !auditEnabled) {
  // No pro token or audit not enabled — silently exit.
  process.exit(0);
}

// Claude Code passes the hook payload on stdin as JSON
let payload: Record<string, unknown> = {};
try {
  const raw = await Bun.stdin.text();
  if (raw.trim()) {
    payload = JSON.parse(raw) as Record<string, unknown>;
  }
} catch {
  // Malformed stdin — exit cleanly
  process.exit(0);
}

const tool      = (payload["tool_name"] as string | undefined) ?? "unknown";
const toolInput = (payload["tool_input"] as Record<string, unknown> | undefined) ?? {};
const cwd       = (payload["cwd"] as string | undefined) ?? "";

/**
 * Redact sensitive argument fields before upload. The server learns the shape
 * of each call (tool name, which paths were touched, byte counts) without
 * seeing the source code, edit diffs, or shell commands themselves. Users who
 * want full-fidelity audit can still opt in via ASHLR_PRO_AUDIT_FULL=1 — but
 * the default is shape-only.
 */
function scrubArgs(name: string, input: Record<string, unknown>): Record<string, unknown> {
  if (process.env["ASHLR_PRO_AUDIT_FULL"] === "1") return input;
  const out: Record<string, unknown> = {};
  const pathFields = ["file_path", "path", "file", "notebook_path"];
  for (const f of pathFields) {
    if (typeof input[f] === "string") out[f] = input[f];
  }
  const sensitive = ["content", "new_string", "old_string", "search", "replace", "command", "body", "edits"];
  for (const f of sensitive) {
    const v = input[f];
    if (typeof v === "string") out[`${f}_bytes`] = v.length;
    else if (Array.isArray(v)) out[`${f}_count`] = v.length;
  }
  return out;
}

// Best-effort git commit from env or cwd
let gitCommit = process.env["GIT_COMMIT"] ?? "";
if (!gitCommit && cwd) {
  try {
    const proc = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--short", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    gitCommit = proc.stdout.toString().trim();
  } catch {
    // Not in a git repo — ignore
  }
}

const body = {
  tool,
  args: scrubArgs(tool, toolInput),
  userId: "", // server resolves from Bearer token
  cwd,
  gitCommit,
  timestamp: new Date().toISOString(),
};

try {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  await fetch(`${baseUrl}/audit/event`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  clearTimeout(timeout);
} catch {
  // Fire-and-forget — any network or timeout error is silently dropped
}

process.exit(0);
