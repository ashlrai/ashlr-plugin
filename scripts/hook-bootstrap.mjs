#!/usr/bin/env node
/**
 * hook-bootstrap.mjs — node trampoline for every hook in hooks/hooks.json.
 *
 * Mirror of scripts/bootstrap.mjs but for the Claude Code hooks surface.
 * Claude Code spawns hook commands with its *own* parent-process PATH, which
 * doesn't include ~/.bun/bin right after a first-run auto-install. Without
 * this trampoline, every hook silently dies with "bun: not found" until the
 * user restarts Claude Code.
 *
 * Flow:
 *   1. If bun is already on PATH: spawn it directly.
 *   2. Otherwise, try prepending ~/.bun/bin (populated by a prior
 *      bootstrap.mjs auto-install from the MCP server spawn).
 *   3. If bun is STILL unreachable: exit 0 silently. Hooks are decoration,
 *      never a gate on the harness — a missing bun here just means the hook
 *      no-ops for this session, not that the user's workflow breaks.
 *
 * Critical: this trampoline NEVER auto-installs bun. Hooks fire concurrently
 * (multiple PreToolUse + PostToolUse in parallel); racing installers would
 * be catastrophic. Only scripts/bootstrap.mjs (MCP server spawn — single
 * producer) is allowed to trigger the installer.
 *
 * ASHLR_NO_AUTO_INSTALL only gates *installation*; PATH *resolution* always
 * runs — we never refuse to look at a bin dir the user already has on disk.
 *
 * Usage (wired from hooks/hooks.json):
 *   node "${CODEX_PLUGIN_ROOT}/scripts/hook-bootstrap.mjs" \
 *        "${CODEX_PLUGIN_ROOT}/hooks/<hook>.ts" [args...]
 *
 * Group mode runs several hooks for one event from a single node process:
 *   node hook-bootstrap.mjs --group [--match <tools>] <hook>.ts [--match <tools>] <hook>.ts ...
 * `--match` takes a Claude Code matcher (`Read|Grep`) and applies to the next
 * hook only; a hook without one always runs. Each hook still runs as its own
 * `bun run` process, in parallel, with the same stdin. Their outputs are
 * merged: `additionalContext` strings are joined, plain-text output is kept,
 * and exit code 2 from any hook wins. Starting node once per event instead of
 * once per hook is what saves the time.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { prependBunToPath } from "./bun-resolve.mjs";

const groupMode = process.argv[2] === "--group";
const hookPath = process.argv[2];
if (!hookPath) {
  process.stderr.write("[ashlr:hook-bootstrap] missing hook path argument\n");
  process.exit(0); // still don't gate the harness
}

const looksLikeCodexPluginHook =
  Boolean(process.env.CODEX_PLUGIN_ROOT) ||
  Boolean(process.env.ASHLR_CODEX_HOOK_MODE) ||
  (Boolean(process.env.CLAUDE_PLUGIN_ROOT) &&
    // Claude Code sets CLAUDECODE=1 for its child processes but neither of
    // the two variables below, so without this check every Claude Code hook
    // ran in Codex nudge mode and suggested bare `ashlr__*` tool names.
    !process.env.CLAUDECODE &&
    !process.env.CLAUDE_SESSION_ID &&
    !process.env.CLAUDE_CODE_MODEL);

if (looksLikeCodexPluginHook && !process.env.ASHLR_MCP_HOST) {
  process.env.ASHLR_MCP_HOST = "codex-cli";
}
if (process.env.ASHLR_MCP_HOST === "codex-cli" && !process.env.ASHLR_HOOK_MODE) {
  process.env.ASHLR_HOOK_MODE = process.env.ASHLR_CODEX_HOOK_MODE || "nudge";
}

/** True when the error means the `bun` executable was not found. */
function bunMissing(error) {
  return Boolean(error) && error.code === "ENOENT";
}

if (groupMode) {
  await runGroup(process.argv.slice(3));
} else {
  runSingle();
}

function runSingle() {
  const forwarded = process.argv.slice(3);
  // End Bun option parsing before the caller-supplied hook path.
  // spawnSync inherits the current environment, including PATH after recovery.
  const run = () => spawnSync("bun", ["run", "--", hookPath, ...forwarded], { stdio: "inherit" });
  let result = run();
  if (bunMissing(result.error)) {
    // Not on PATH: try ~/.bun/bin (a prior bootstrap.mjs install). If bun is
    // still unreachable, exit 0. Hooks must never fail the harness; the MCP
    // server's bootstrap.mjs installs bun on its next spawn.
    prependBunToPath();
    result = run();
    if (bunMissing(result.error)) process.exit(0);
  }
  if (result.error) {
    process.stderr.write(`[ashlr:hook-bootstrap] ${result.error.message}\n`);
    process.exit(0);
  }
  process.exit(result.status ?? 0);
}

/** Claude Code matcher semantics: empty or `*` matches all, else a regex over the whole tool name. */
function matches(matcher, toolName) {
  if (!matcher || matcher === "*") return true;
  if (!toolName) return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
}

function parseGroup(args) {
  const hooks = [];
  let matcher = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--match") {
      matcher = args[++i] ?? null;
      continue;
    }
    hooks.push({ path: args[i], matcher });
    matcher = null;
  }
  return hooks;
}

function runHook(path, input) {
  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawn("bun", ["run", path], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    } catch (error) {
      resolveRun({ error, status: 0, stdout: "", stderr: "" });
      return;
    }
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (error) => resolveRun({ error, status: 0, stdout: "", stderr: "" }));
    child.on("close", (status) =>
      resolveRun({
        error: null,
        status: status ?? 0,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.stdin.on("error", () => {}); // a hook that exits without reading stdin
    child.stdin.end(input);
  });
}

async function runGroup(args) {
  let input = Buffer.alloc(0);
  try {
    input = readFileSync(0);
  } catch {
    // No stdin (manual run): hooks get an empty payload.
  }
  let payload = {};
  try {
    payload = JSON.parse(input.toString("utf8") || "{}");
  } catch {
    // Unparseable payload: run every hook and let each decide.
  }
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const selected = parseGroup(args).filter((h) => matches(h.matcher, toolName));
  if (selected.length === 0) process.exit(0);

  let results = await Promise.all(selected.map((h) => runHook(h.path, input)));
  if (results.some((r) => bunMissing(r.error))) {
    prependBunToPath();
    results = await Promise.all(selected.map((h) => runHook(h.path, input)));
    if (results.some((r) => bunMissing(r.error))) process.exit(0);
  }

  const contexts = [];
  const plain = [];
  let merged = null;
  let blocking = null;
  let failure = 0;
  for (const r of results) {
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.error) {
      process.stderr.write(`[ashlr:hook-bootstrap] ${r.error.message}\n`);
      continue;
    }
    if (r.status === 2 && blocking === null) blocking = r;
    else if (r.status !== 0 && failure === 0) failure = r.status;
    const text = r.stdout.trim();
    if (!text) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Plain-text output.
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      plain.push(text);
      continue;
    }
    const { hookSpecificOutput, ...rest } = parsed;
    merged = { ...(merged ?? {}), ...rest };
    if (hookSpecificOutput && typeof hookSpecificOutput.additionalContext === "string" && hookSpecificOutput.additionalContext) {
      contexts.push(hookSpecificOutput.additionalContext);
    }
    if (hookSpecificOutput && !event && typeof hookSpecificOutput.hookEventName === "string") {
      merged.__event = hookSpecificOutput.hookEventName;
    }
  }

  if (blocking) process.exit(2);

  if (merged === null && contexts.length === 0) {
    // Every hook printed plain text (or nothing): keep it as plain text.
    if (plain.length > 0) process.stdout.write(plain.join("\n\n") + "\n");
    process.exit(failure);
  }
  const { __event, ...top } = merged ?? {};
  // Mixed output: plain text joins the JSON's context so nothing is lost.
  const allContext = [...contexts, ...plain];
  const output = { ...top };
  if (allContext.length > 0) {
    output.hookSpecificOutput = { hookEventName: event || __event, additionalContext: allContext.join("\n\n") };
  }
  process.stdout.write(JSON.stringify(output));
  process.exit(failure);
}
