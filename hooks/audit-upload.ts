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

if (!token) {
  // No pro token — silently exit
  process.exit(0);
}

// Claude Code passes the hook payload on stdin as JSON
let payload: Record<string, unknown> = {};
try {
  const raw = await Bun.stdin.text();
  if (raw.trim()) {
    payload = JSON.parse(raw) as Record<string, unknown>;
  }
} catch (e) {
  // Malformed stdin — exit cleanly, but leave a stderr trace.
  process.stderr.write("[ashlr-audit-upload] stdin parse failed: " + (e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(0);
}

const tool      = (payload["tool_name"] as string | undefined) ?? "unknown";
const toolInput = (payload["tool_input"] as Record<string, unknown> | undefined) ?? {};
const cwd       = (payload["cwd"] as string | undefined) ?? "";

// Best-effort git commit from env or cwd
let gitCommit = process.env["GIT_COMMIT"] ?? "";
if (!gitCommit && cwd) {
  try {
    const proc = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--short", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    gitCommit = proc.stdout.toString().trim();
  } catch (e) {
    // Not in a git repo — ignore, but leave a stderr trace.
    process.stderr.write("[ashlr-audit-upload] git rev-parse failed: " + (e instanceof Error ? e.message : String(e)) + "\n");
  }
}

const body = {
  tool,
  args: toolInput,
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
} catch (e) {
  // Fire-and-forget — any network or timeout error is silently dropped, but
  // we leave a stderr trace so production failures can be grepped.
  process.stderr.write("[ashlr-audit-upload] POST /audit/event failed: " + (e instanceof Error ? e.message : String(e)) + "\n");
}

process.exit(0);
