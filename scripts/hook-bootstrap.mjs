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
import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { prependBunToPath, resolveBunExecutable } from "./bun-resolve.mjs";

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

/**
 * The trampoline only ever runs hooks that ship inside the plugin's hooks/
 * directory — it is a hook runner, not an arbitrary-file executor. Every
 * caller-supplied path is resolved to its real location and required to stay
 * inside that directory before it can reach a child_process call.
 */
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOKS_DIR = resolve(PLUGIN_ROOT, "hooks");
const HOOK_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const MAX_HOOK_ARG_LENGTH = 4096;
// Control characters (including NUL) can never legitimately appear in an
// execvp argument or a file path — anything containing one is malformed
// input, not a hook argument.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** Path of `child` relative to `dir`, or null when it escapes `dir`. */
function relativeInside(dir, child) {
  const rel = relative(dir, child);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
}

/**
 * Resolve `candidate` to a script file inside the plugin hooks/ directory,
 * or null when it fails validation. Containment is checked twice: first on
 * the lexical path (before any filesystem call touches it), then again on the
 * canonical realpath so a symlinked plugin root can't slip the prefix check —
 * and a symlink inside hooks/ can't escape it either.
 */
function validHookFile(candidate) {
  if (typeof candidate !== "string" || !candidate || CONTROL_CHARS.test(candidate)) return null;
  if (!HOOK_EXTENSIONS.has(extname(candidate))) return null;
  const resolved = resolve(candidate);
  if (relativeInside(HOOKS_DIR, resolved) === null) return null;
  let real;
  try {
    real = realpathSync(resolved);
    if (!statSync(real).isFile()) return null;
    return relativeInside(realpathSync(HOOKS_DIR), real) === null ? null : real;
  } catch {
    return null;
  }
}

/** Forwarded arguments reach the hook verbatim; reject malformed ones. */
function validHookArgs(args) {
  return args.every(
    (arg) => typeof arg === "string" && arg.length <= MAX_HOOK_ARG_LENGTH && !CONTROL_CHARS.test(arg),
  );
}

/**
 * Absolute path to the bun executable, or null. Resolving up front (instead
 * of letting spawn search PATH at exec time) guarantees the binary we run is
 * one we located ourselves and keeps the same recovery semantics: a missing
 * PATH entry falls back to ~/.bun/bin from a prior bootstrap.mjs install.
 */
function bunExecutable() {
  let bin = resolveBunExecutable();
  if (!bin) {
    prependBunToPath();
    bin = resolveBunExecutable();
  }
  return bin;
}

function refuseInvalid(what) {
  process.stderr.write(`[ashlr:hook-bootstrap] refusing to run: invalid ${what}\n`);
}

if (groupMode) {
  await runGroup(process.argv.slice(3));
} else {
  runSingle();
}

function runSingle() {
  const hook = validHookFile(hookPath);
  const forwarded = process.argv.slice(3);
  if (!hook || !validHookArgs(forwarded)) {
    refuseInvalid("hook argument");
    process.exit(0); // still don't gate the harness
  }
  const bun = bunExecutable();
  if (!bun) process.exit(0);
  // End Bun option parsing before the caller-supplied hook path.
  // spawnSync inherits the current environment, including PATH after recovery.
  const result = spawnSync(bun, ["run", "--", hook, ...forwarded], { stdio: "inherit" });
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

function runHook(bun, path, input) {
  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawn(bun, ["run", "--", path], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
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
  const selected = [];
  for (const entry of parseGroup(args)) {
    if (!matches(entry.matcher, toolName)) continue;
    const file = validHookFile(entry.path);
    if (!file) {
      process.stderr.write(`[ashlr:hook-bootstrap] skipping invalid hook path ${JSON.stringify(entry.path)}\n`);
      continue;
    }
    selected.push(file);
  }
  if (selected.length === 0) process.exit(0);
  const bun = bunExecutable();
  if (!bun) process.exit(0);

  const results = await Promise.all(selected.map((file) => runHook(bun, file, input)));

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
