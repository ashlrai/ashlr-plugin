#!/usr/bin/env bun
/**
 * ashlr onboarding wizard — guides first-time users through setup.
 *
 * Designed to be driven by the /ashlr-start skill. Each section emits
 * structured output: plain text blocks + [ASHLR_*] markers the skill
 * uses to drive user Q&A and take action.
 *
 * Usage:
 *   bun run scripts/onboarding-wizard.ts               # interactive
 *   bun run scripts/onboarding-wizard.ts --no-interactive
 *   bun run scripts/onboarding-wizard.ts --reset       # delete stamp
 *
 * Stdout: the wizard transcript (pipe-safe, 72-char width).
 * Stderr: timing / debug info.
 *
 * Contract: exits 0 on success, 1 only on fatal I/O errors.
 * Never throws to the caller.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { readFile, unlink } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { createInterface } from "readline";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STAMP_FILENAME = "installed-at";
export const WIDTH = 72;
export const YES_TIMEOUT_MS = 5000;
/**
 * Permissions prompt timeout is longer than the generic YES_TIMEOUT_MS so
 * the user has time to register that a grant is happening before it
 * auto-accepts. Paired with a once-per-second visible countdown so the
 * "it just auto-approved without asking me" UX bug can't recur.
 */
export const PERMISSIONS_COUNTDOWN_MS = 30_000;
const TOTAL_STEPS = 9;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function stampPath(home: string = homedir()): string {
  return join(home, ".ashlr", STAMP_FILENAME);
}

export function ashlrDir(home: string = homedir()): string {
  return join(home, ".ashlr");
}

/**
 * Path to the restart-required hint file. The wizard writes this when it
 * finishes; the SessionStart hook reads + clears it to detect when a user
 * completed the wizard but didn't actually restart Claude Code (and is
 * therefore about to fall back to built-in Read/Edit/Grep without realizing).
 */
export function restartRequiredPath(home: string = homedir()): string {
  return join(home, ".ashlr", "restart-required");
}

/**
 * Read this plugin's package.json version. Best-effort — returns "unknown"
 * on any failure so wizard rendering never crashes on a corrupted install.
 */
export function readPackageVersionSafe(): string {
  try {
    // package.json lives one directory up from scripts/
    const pkgPath = join(import.meta.dir, "..", "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    /* ignore — best-effort */
  }
  return "unknown";
}

/**
 * Write the restart-required hint file with the current timestamp + pid +
 * wizard version. Best-effort: wrapped in try/catch so a readonly HOME
 * never errors the wizard.
 *
 * Shape: { writtenAt: ISO8601, wizardVersion: string, pid: number }
 *
 * Consumed by hooks/session-start.ts, which compares writtenAt + pid against
 * its own to decide whether the user actually restarted Claude Code.
 */
export function writeRestartRequired(home: string = homedir()): void {
  try {
    mkdirSync(ashlrDir(home), { recursive: true });
    const payload = {
      writtenAt: new Date().toISOString(),
      wizardVersion: readPackageVersionSafe(),
      pid: process.pid,
    };
    writeFileSync(restartRequiredPath(home), JSON.stringify(payload, null, 2) + "\n");
  } catch {
    /* best-effort — readonly HOME, full disk, etc. must never error wizard */
  }
}

// ---------------------------------------------------------------------------
// Onboarding state machine
// ---------------------------------------------------------------------------

export interface OnboardingState {
  started: boolean;
  completed: boolean;
  completedAt?: string;
  lastStep?: number;
}

export function onboardingStatePath(home: string = homedir()): string {
  return join(home, ".ashlr", "onboarding.json");
}

export function readOnboardingState(home: string = homedir()): OnboardingState | null {
  try {
    const p = onboardingStatePath(home);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as OnboardingState;
  } catch {
    /* treat as missing */
  }
  return null;
}

export function writeOnboardingState(state: OnboardingState, home: string = homedir()): void {
  try {
    const dir = ashlrDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(onboardingStatePath(home), JSON.stringify(state, null, 2) + "\n");
  } catch {
    /* best-effort */
  }
}

/**
 * Mark that the wizard has started (idempotent — only writes if not already started).
 * Call at the beginning of runWizard.
 */
export function markOnboardingStarted(home: string = homedir()): void {
  const existing = readOnboardingState(home) ?? { started: false, completed: false };
  if (!existing.started) {
    writeOnboardingState({ ...existing, started: true }, home);
  }
}

/**
 * Mark progress within the wizard. lastStep is the 1-based step number just completed.
 */
export function markOnboardingStep(step: number, home: string = homedir()): void {
  const existing = readOnboardingState(home) ?? { started: true, completed: false };
  writeOnboardingState({ ...existing, started: true, lastStep: step }, home);
}

/**
 * Mark the wizard as fully completed.
 */
export function markOnboardingCompleted(home: string = homedir()): void {
  writeOnboardingState(
    { started: true, completed: true, completedAt: new Date().toISOString() },
    home,
  );
}

// ---------------------------------------------------------------------------
// Stamp helpers
// ---------------------------------------------------------------------------

export function isFirstRun(home: string = homedir()): boolean {
  return !existsSync(stampPath(home));
}

export function writeStamp(home: string = homedir()): void {
  try {
    const dir = ashlrDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stampPath(home), new Date().toISOString());
  } catch {
    /* best-effort */
  }
}

export async function deleteStamp(home: string = homedir()): Promise<void> {
  try {
    await unlink(stampPath(home));
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function divider(step: number, label: string): string {
  const tag = `STEP ${step}/${TOTAL_STEPS}: ${label}`;
  const rem = Math.max(0, WIDTH - 8 - tag.length);
  return `${"▬".repeat(4)} ${tag} ${"▬".repeat(Math.max(4, rem))}`;
}

function wrap(text: string, width: number = WIDTH): string {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += " " + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Plugin root
// ---------------------------------------------------------------------------

export function resolvePluginRoot(): string {
  const env = process.env.CLAUDE_PLUGIN_ROOT;
  if (env && existsSync(join(env, ".claude-plugin/plugin.json"))) return env;
  // Walk up from this script's location
  let dir = import.meta.dir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".claude-plugin/plugin.json"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(import.meta.dir);
}

// ---------------------------------------------------------------------------
// Source file counting
// ---------------------------------------------------------------------------

const SRC_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".swift", ".c", ".cpp", ".h", ".cs", ".php",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out",
  ".next", ".nuxt", "coverage", ".ashlrcode",
]);

export function countSourceFiles(dir: string, maxScan = 500): number {
  let count = 0;
  const queue: string[] = [dir];
  while (queue.length > 0 && count <= maxScan) {
    const current = queue.shift()!;
    let names: string[];
    try {
      names = readdirSync(current) as string[];
    } catch {
      continue;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(current, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        queue.push(full);
      } else {
        const ext = "." + name.split(".").pop()!.toLowerCase();
        if (SRC_EXTS.has(ext)) count++;
        if (count > maxScan) break;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Doctor check (lightweight local subset — no MCP probing)
// ---------------------------------------------------------------------------

export interface DoctorResult {
  pluginRoot: string | null;
  hasDeps: boolean;
  allowlistOk: boolean;
  genomePresent: boolean;
  issues: string[];
}

export async function runDoctorCheck(
  opts: { home?: string; cwd?: string; pluginRoot?: string } = {}
): Promise<DoctorResult> {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const pluginRoot = opts.pluginRoot ?? resolvePluginRoot();

  const issues: string[] = [];

  // Plugin root
  const rootOk = pluginRoot !== null && existsSync(join(pluginRoot, ".claude-plugin/plugin.json"));
  if (!rootOk) issues.push("Plugin root not found — set CLAUDE_PLUGIN_ROOT");

  // Dependencies
  const hasDeps = existsSync(join(pluginRoot ?? "", "node_modules/@modelcontextprotocol/sdk"));
  if (!hasDeps) issues.push(`Dependencies missing — run: cd "${pluginRoot}" && bun install`);

  // Allowlist
  const settingsPath = join(home, ".claude/settings.json");
  let allowlistOk = false;
  try {
    if (existsSync(settingsPath)) {
      const raw = await readFile(settingsPath, "utf8");
      const s = JSON.parse(raw) as { permissions?: { allow?: string[] } };
      const allow = s?.permissions?.allow ?? [];
      allowlistOk = allow.some((e: string) => /^mcp__ashlr(-|__)/.test(e) || e === "mcp__ashlr-*");
    }
  } catch {
    /* treat as not present */
  }

  // Genome
  const genomePresent = existsSync(join(cwd, ".ashlrcode", "genome"));

  return { pluginRoot, hasDeps, allowlistOk, genomePresent, issues };
}

// ---------------------------------------------------------------------------
// Live demo: find a readable source file
// ---------------------------------------------------------------------------

export function findDemoFile(cwd: string): string | null {
  const candidates = [
    join(cwd, "scripts/session-greet.ts"),
    join(cwd, "scripts/doctor.ts"),
    join(cwd, "hooks/session-start.ts"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fall back: first .ts file found (non-test, non-node_modules)
  const queue: string[] = [cwd];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let names: string[];
    try {
      names = readdirSync(dir) as string[];
    } catch {
      continue;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      if (name.startsWith("__tests__")) continue;
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        queue.push(full);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        return full;
      }
    }
  }
  return null;
}

export function fileSizeBytes(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

// Approximate read payload: ashlr__read returns head+tail ~25% of original
// for large files. We model this without actually calling the MCP tool so the
// wizard script is self-contained and can run without MCP active. The real
// live-demo path (runRealReadDemo) supersedes this estimate whenever the
// efficiency-server is reachable; the estimate is the fallback.
export function estimateReadPayload(sizeBytes: number): number {
  if (sizeBytes <= 4096) return sizeBytes; // small file: full content
  // snipCompact: ~30 head lines + ~20 tail lines ≈ 50 lines * ~60 chars = 3000
  // plus elision marker. Conservative estimate: 40% of original, min 3KB.
  return Math.max(3000, Math.round(sizeBytes * 0.35));
}

/** Result of the real live demo — either a measured payload size or an error. */
export interface RealReadDemoResult {
  /** Bytes returned by ashlr__read. null when the real call failed. */
  payloadBytes: number | null;
  /** First ~240 chars of the compact payload for display. null on failure. */
  sample: string | null;
  /** Non-fatal failure reason (logged as [ASHLR_WARN], fall back to estimate). */
  error: string | null;
}

/**
 * Invoke the real ashlr__read MCP tool via a subprocess against the
 * efficiency-server. We shell out instead of importing the server module
 * directly because the wizard runs as a plain script and shouldn't pull the
 * full MCP stack into memory. The server is invoked with a throwaway stdio
 * transport, handed exactly one tools/call request, and its stdout parsed.
 *
 * Falls back cleanly when:
 *   - The plugin root can't be resolved.
 *   - The efficiency-server script is missing.
 *   - The spawn times out (12 s ceiling — long enough for cold Bun spawns
 *     on slower laptops, still keeps the wizard well under 60 s overall).
 *   - The JSON response is malformed.
 *
 * On any failure returns `error` set and the caller renders the fake
 * estimate so onboarding still tells a coherent story.
 */
export async function runRealReadDemo(
  demoFile: string,
  opts: { pluginRoot?: string; timeoutMs?: number } = {},
): Promise<RealReadDemoResult> {
  const timeoutMs = opts.timeoutMs ?? 12000;
  const pluginRoot = opts.pluginRoot ?? resolvePluginRoot();
  const serverPath = join(pluginRoot, "servers/efficiency-server.ts");
  if (!existsSync(serverPath)) {
    return { payloadBytes: null, sample: null, error: "efficiency-server not found" };
  }

  // Minimal JSON-RPC request: initialize then tools/call → ashlr__read.
  // The server follows the MCP stdio protocol so we write framed lines.
  // We pipe a single request and close stdin; server exits via EOF.
  const initReq = {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ashlr-wizard", version: "0" } },
  };
  const toolReq = {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "ashlr__read", arguments: { path: demoFile } },
  };
  const payload = JSON.stringify(initReq) + "\n" + JSON.stringify(toolReq) + "\n";

  let childStdout = "";
  try {
    const { spawn } = await import("child_process");
    const child = spawn("bun", ["run", serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ASHLR_WIZARD_DEMO: "1" },
    });
    child.stdout.on("data", (chunk: Buffer) => { childStdout += chunk.toString("utf8"); });
    child.stdin.write(payload);
    child.stdin.end();

    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* ignore */ } resolve(); }, timeoutMs);
      child.on("exit", () => { clearTimeout(t); resolve(); });
      child.on("error", () => { clearTimeout(t); resolve(); });
    });
  } catch (err) {
    return { payloadBytes: null, sample: null, error: err instanceof Error ? err.message : String(err) };
  }

  // Parse the stream for the id=2 response.
  type ReadResp = { result?: { content?: Array<{ type: string; text?: string }> } };
  let readResponse: ReadResp | null = null;
  for (const raw of childStdout.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] !== "{") continue;
    try {
      const msg = JSON.parse(line) as { id?: number } & ReadResp;
      if (msg.id === 2 && msg.result) {
        readResponse = msg;
        break;
      }
    } catch {
      /* skip non-JSON frame */
    }
  }
  if (!readResponse?.result?.content) {
    return { payloadBytes: null, sample: null, error: "no tool response" };
  }
  const text = (readResponse.result.content[0]?.text) ?? "";
  if (text.length === 0) {
    return { payloadBytes: null, sample: null, error: "empty payload" };
  }
  const sample = text.slice(0, 240);
  return { payloadBytes: Buffer.byteLength(text, "utf8"), sample, error: null };
}

// ---------------------------------------------------------------------------
// Interactive confirmation
// ---------------------------------------------------------------------------

export async function askYesNo(
  question: string,
  defaultYes: boolean = true,
  timeoutMs: number = YES_TIMEOUT_MS,
  interactive: boolean = true,
): Promise<boolean> {
  if (!interactive) return defaultYes;

  const hint = defaultYes ? "Y/n" : "y/N";
  process.stdout.write(`${question} [${hint}]: `);

  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        rl.close();
        process.stdout.write(`(timeout — defaulting to ${defaultYes ? "yes" : "no"})\n`);
        resolve(defaultYes);
      }
    }, timeoutMs);

    rl.once("line", (line) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rl.close();
        const trimmed = line.trim().toLowerCase();
        if (trimmed === "") resolve(defaultYes);
        else resolve(trimmed === "y" || trimmed === "yes");
      }
    });

    rl.once("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(defaultYes);
      }
    });
  });
}

/**
 * Yes/no prompt with a visible per-second countdown before auto-accept.
 *
 * Used for the permissions grant so the user can't miss that a grant is
 * about to happen — the previous 5-second silent timeout shipped users
 * a "ashlr auto-approved without asking me" experience. Typing y/Enter
 * accepts early, n rejects, timeout = accept.
 *
 * The countdown prints one line per second using a carriage return so the
 * terminal only ever shows the current count, not a vertical stack. When
 * stdin is consumed the line is overwritten with a final status message.
 */
export async function askYesNoWithCountdown(
  question: string,
  totalMs: number = PERMISSIONS_COUNTDOWN_MS,
  interactive: boolean = true,
): Promise<boolean> {
  if (!interactive) return true;

  const totalSec = Math.max(1, Math.round(totalMs / 1000));
  process.stdout.write(`${question} [Y/n]\n`);
  process.stdout.write(`(Auto-accepting in ${totalSec}... press y/Enter to accept, n to deny)\n`);

  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    let remaining = totalSec;

    const finish = (accepted: boolean, msg?: string): void => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      rl.close();
      // Clear the countdown line and print the final disposition so the user
      // sees an unambiguous "what happened" line in the transcript.
      process.stdout.write("\r\x1b[2K");
      if (msg) process.stdout.write(msg + "\n");
      resolve(accepted);
    };

    const tick = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        finish(true, "(timeout — auto-accepting permissions)");
        return;
      }
      // \r + CSI 2K clears the current line so counters overwrite cleanly.
      process.stdout.write(`\rAuto-accepting in ${remaining}... `);
    }, 1000);

    rl.once("line", (line) => {
      const trimmed = line.trim().toLowerCase();
      if (trimmed === "n" || trimmed === "no") {
        finish(false, "(declined)");
      } else {
        finish(true, "(accepted)");
      }
    });

    rl.once("close", () => {
      if (!settled) finish(true, "(stream closed — auto-accepting)");
    });
  });
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function out(s: string): void {
  process.stdout.write(s + "\n");
}

function blank(): void {
  out("");
}

// Step 0: greeting
export function renderGreeting(): void {
  blank();
  out("▬".repeat(WIDTH));
  out(wrap("You just installed ashlr. Let's show you what it does."));
  out(wrap(
    "This wizard takes about 60 seconds. Press Enter to accept " +
    "defaults at each prompt."
  ));
  out("▬".repeat(WIDTH));
  blank();
  out("ashlr in 60 seconds:");
  out("  1. /ashlr-doctor       — verify install (10s)");
  out("  2. status line install — see savings as you code (15s, restart required)");
  out("  3. /ashlr-genome-init  — boost grep savings 40% → 84% (30s)");
  blank();
  out(wrap(
    "Core MCP tools (all return compressed output to save tokens):"
  ));
  out("  ashlr__read          — smart head+tail file reader");
  out("  ashlr__grep          — filtered search with line limits");
  out("  ashlr__edit          — compressed edit acknowledgements");
  out("  ashlr__diff          — compact diff output");
  out("  ashlr__bash          — bash with summarized output");
  blank();
  out(wrap(
    "New in this version:"
  ));
  out("  ashlr__websearch     — compressed web search results");
  out("  ashlr__task_list     — compressed task list output");
  out("  ashlr__task_get      — compressed task detail output");
  out("  ashlr__notebook_edit — compressed notebook cell edits");
  out("  ashlr__write         — compressed file write acknowledgements");
  blank();
}

// Step 1: doctor check
export function renderDoctorOutput(result: DoctorResult): void {
  out(divider(1, "Doctor check"));
  blank();
  out(`Plugin root:  ${result.pluginRoot ?? "(not found)"}`);
  out(`Dependencies: ${result.hasDeps ? "installed" : "MISSING"}`);
  out(`Allowlist:    ${result.allowlistOk ? "auto-approved" : "not configured"}`);
  out(`Genome:       ${result.genomePresent ? "present" : "not initialized"}`);
  blank();
  if (result.issues.length === 0) {
    out("[ASHLR_OK] doctor-passed");
  } else {
    for (const issue of result.issues) {
      out(`[ASHLR_WARN] ${issue}`);
    }
  }
  blank();
}

// Step 2: permissions
export function renderPermissionsSection(allowlistOk: boolean): void {
  out(divider(2, "Permissions"));
  blank();
  if (allowlistOk) {
    out(wrap(
      "Your ~/.claude/settings.json already auto-approves all ashlr " +
      "tools. No action needed."
    ));
    out("[ASHLR_OK] permissions-ok");
  } else {
    out(wrap(
      "~/.claude/settings.json does not auto-approve ashlr tools. " +
      "Without this, Claude Code prompts you for every ashlr__read, " +
      "ashlr__grep, and ashlr__edit call — dozens of prompts per session."
    ));
    blank();
    out("[ASHLR_PROMPT: Auto-approve all ashlr tools? (y/n, default y)]");
  }
  blank();
}

// Step 3: status-line offer
export function renderStatusLineSection(statusLineInstalled: boolean): void {
  out(divider(3, "Status line"));
  blank();
  if (statusLineInstalled) {
    out(wrap(
      "Status line already configured — live savings counter is active."
    ));
    out("[ASHLR_OK] status-line-present");
    blank();
    return;
  }
  out(wrap(
    "Show real-time savings in your status bar — recommended. " +
    "The status line displays a live counter of tokens and cost saved " +
    "at the bottom of every Claude Code session."
  ));
  blank();
  out("[ASHLR_PROMPT: Install status line? (Y/n, default y)]");
  blank();
}

/**
 * End-of-wizard "restart enforcement" callout. The LOUD block addresses
 * UX-audit cliff #2: users finished the wizard, ignored the soft callout,
 * ran their next tool call, and saw built-in Read/Edit/Grep fire instead
 * of ashlr's tools — making the plugin look broken when the user just
 * didn't quit Claude Code.
 *
 * Side effect: writes ~/.ashlr/restart-required as a hint file. The
 * SessionStart hook reads it on the next session start; if the pid matches
 * (same shell, no restart) it warns the user, otherwise it silently clears
 * the hint.
 */
export function renderRestartCallout(home: string = homedir()): void {
  blank();
  out("═══════════════════════════════════════════════════════════════════");
  out("  RESTART REQUIRED — your next tool call will NOT use ashlr until");
  out("  you fully quit and reopen Claude Code (not just close the window).");
  out("");
  out("  Plugin tools register on session start; without a restart, the");
  out("  built-in Read/Edit/Grep run instead and you'll see no savings.");
  out("═══════════════════════════════════════════════════════════════════");
  blank();
  writeRestartRequired(home);
}

// Step 4: live demo
export function renderLiveDemoSection(
  demoFile: string | null,
  sizeBytes: number,
  payloadBytes: number,
  opts: { real?: boolean; sample?: string | null; error?: string | null } = {},
): void {
  out(divider(4, "Live demo"));
  blank();
  if (!demoFile) {
    out(wrap(
      "No source files found in the current directory to demo. " +
      "Skipping read comparison."
    ));
    out("[ASHLR_OK] demo-skipped");
    blank();
    return;
  }

  const pct = sizeBytes > 0 ? Math.round((payloadBytes / sizeBytes) * 100) : 100;
  const saved = Math.max(0, sizeBytes - payloadBytes);
  const shortName = demoFile.replace(homedir(), "~");
  const readLabel = opts.real ? "ashlr__read:" : "ashlr__read:";
  const realityTag = opts.real ? " (live)" : " (estimate)";

  out(`File:         ${shortName}`);
  out(`Disk size:    ${sizeBytes.toLocaleString()} bytes`);
  out(`${readLabel}  ${payloadBytes.toLocaleString()} bytes returned (~${pct}% of file)${realityTag}`);
  out(`Saved:        ${saved.toLocaleString()} bytes not sent to the model`);
  blank();
  if (opts.real && opts.sample) {
    out(wrap(
      "Live output (first 240 chars of the compact payload):"
    ));
    blank();
    // Display the sample inside a faux fenced-preview block using ▸ so the
    // transcript stays plain-text pipeable.
    for (const line of opts.sample.split("\n").slice(0, 8)) {
      out("▸ " + line.replace(/\s+$/, ""));
    }
    blank();
  } else if (opts.error) {
    out(wrap(
      `Live read failed (${opts.error}); showing an estimated payload size ` +
      "based on the snipCompact model instead."
    ));
    blank();
  }
  out(wrap(
    "ashlr__read returns a snipCompact view: full head + full tail + " +
    "elided middle. The model sees the structure and entry/exit points " +
    "of every file without ingesting the full body."
  ));
  out("[ASHLR_OK] demo-complete");
  blank();
}

// Step 5: genome offer
//
// `aha` is an optional inline before/after token demo used to make the value
// statement concrete: a real file from the user's repo with the
// "without genome / with genome" token counts side-by-side. Computed in
// runWizard from data we already have (demoFile + fileSizeBytes) so the
// render path stays sub-1-second and doesn't fire any new I/O. Skip the demo
// (pass undefined) when no demo file was found — the one-liner value
// statement is still shown.
export interface GenomeAhaDemo {
  filePath: string;
  sizeBytes: number;
  /** Token estimate without genome (raw file, ~4 chars/token). */
  withoutGenomeTokens: number;
  /** Token estimate with genome (snipCompact ~20%, floor at 200 tok). */
  withGenomeTokens: number;
}

/**
 * Precompute the genome-aha before/after demo from numbers the wizard already
 * has. Pure function, sub-millisecond. Returns null when no demo file exists
 * or the file is too small to meaningfully demo against (< 4KB).
 *
 * Token model: ~4 chars per token (industry rule of thumb). snipCompact
 * typically returns ~20% of the original for files > a few KB, so we
 * multiply by 0.2 with a 200-token floor (snipCompact always retains
 * head+tail markers).
 */
export function computeGenomeAhaDemo(
  demoFile: string | null,
  sizeBytes: number,
): GenomeAhaDemo | null {
  if (!demoFile) return null;
  if (sizeBytes < 4096) return null; // too small to be a convincing demo
  const withoutGenomeTokens = Math.round(sizeBytes / 4);
  const withGenomeTokens = Math.max(200, Math.round((sizeBytes * 0.2) / 4));
  return { filePath: demoFile, sizeBytes, withoutGenomeTokens, withGenomeTokens };
}

export function renderGenomeSection(
  srcFileCount: number,
  genomePresent: boolean,
  aha?: GenomeAhaDemo | null,
): void {
  out(divider(5, "Genome"));
  blank();
  if (genomePresent) {
    out(wrap("Genome already initialized in this project. You're all set."));
    out("[ASHLR_OK] genome-present");
    blank();
    return;
  }

  // Value statement — always shown, even on small repos. Users skip genome
  // init because the prompt never explains the magnitude of the win. The
  // "~84%" number is the measured grep token-savings ceiling across our
  // benchmark repos (see CHANGELOG v1.23 "honest headline -57%" → genome
  // path can reach ~84% on warm caches with dense embeddings).
  out(wrap(
    "Genome unlocks ~84% token savings on grep across this codebase by " +
    "pre-indexing symbol definitions — Claude retrieves targeted " +
    "excerpts instead of raw file content."
  ));
  blank();

  // Inline before/after demo when we have a real file to point at. Numbers
  // are precomputed (see computeGenomeAhaDemo) so render stays sub-1s.
  if (aha) {
    const shortName = aha.filePath.replace(homedir(), "~");
    out(`Example: ${shortName} (${aha.sizeBytes.toLocaleString()} bytes)`);
    out(`  Without genome: ~${aha.withoutGenomeTokens.toLocaleString()} tokens`);
    out(`  With genome:    ~${aha.withGenomeTokens.toLocaleString()} tokens`);
    blank();
  }

  if (srcFileCount < 10) {
    // Small/greenfield repos used to be silently skipped here, which meant
    // brand-new projects never saw ashlr's strongest feature. Offer it
    // anyway with a soft caveat — the default flips to "no" so the user
    // has to opt in, and the genome is cheap to nuke if abandoned (just
    // delete .ashlrcode/genome/).
    out(
      wrap(
        `Only ${srcFileCount} source file${srcFileCount === 1 ? "" : "s"} found ` +
        "in the current directory. Savings compound with repo size, so the " +
        "win on a small/greenfield project is modest right now — but " +
        "initializing one seeds the index for when the project grows."
      )
    );
    blank();
    out("[ASHLR_PROMPT: Initialize a genome anyway? (y/n, default n)]");
    blank();
    return;
  }

  out(
    wrap(
      `Found ${srcFileCount} source files. Initializing the genome now is a ` +
      "one-time ~30 s indexing pass; every subsequent grep call benefits."
    )
  );
  blank();
  out("[ASHLR_PROMPT: Initialize a genome for this project? (y/n, default y)]");
  blank();
}

// ---------------------------------------------------------------------------
// Telemetry opt-in (Step 6) — config: { "telemetry": "opt-in" | "off" }
//
// See docs/telemetry.md for the full contract: ASHLR_TELEMETRY=on/off (env)
// or ~/.ashlr/config.json { "telemetry": "opt-in" | "off" }. Strictly opt-in;
// default is OFF. We persist via the same ~/.ashlr/config.json file the
// Ollama step writes to (preserve sibling keys).
// ---------------------------------------------------------------------------

export interface TelemetryOfferState {
  /** Telemetry already set to opt-in via config or env — skip the prompt. */
  alreadyOptedIn: boolean;
  /** Telemetry already set to "off" via config or env — skip the prompt. */
  alreadyOptedOut: boolean;
  /** Config file we'd write to if the user accepts. */
  configPath: string;
}

/**
 * Inspect ~/.ashlr/config.json + ASHLR_TELEMETRY env to decide whether to
 * surface the consent prompt. We respect any prior explicit choice so the
 * wizard never overrides an existing opt-out and never re-prompts an
 * already-opted-in user.
 */
export function detectTelemetryState(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): TelemetryOfferState {
  const envVal = (env.ASHLR_TELEMETRY ?? "").toLowerCase().trim();
  const envOn = envVal === "on" || envVal === "1";
  const envOff = envVal === "off" || envVal === "0";

  let cfg: Record<string, unknown> = {};
  try {
    const path = join(home, ".ashlr", "config.json");
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") cfg = parsed as Record<string, unknown>;
    }
  } catch {
    /* treat as empty */
  }

  const cfgOptIn = cfg.telemetry === "opt-in";
  const cfgOff = cfg.telemetry === "off";

  return {
    alreadyOptedIn: envOn || cfgOptIn,
    alreadyOptedOut: envOff || cfgOff,
    configPath: join(home, ".ashlr", "config.json"),
  };
}

/**
 * Persist telemetry consent to ~/.ashlr/config.json — preserving sibling
 * keys (e.g. ASHLR_EMBED_URL from the Ollama step). Best-effort: failures
 * are logged via [ASHLR_WARN] and don't block the wizard.
 */
export async function writeTelemetryChoice(
  choice: "opt-in" | "off",
  home: string = homedir(),
): Promise<{ ok: boolean; path: string; error?: string }> {
  const path = join(home, ".ashlr", "config.json");
  try {
    mkdirSync(ashlrDir(home), { recursive: true });
    let existing: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
      } catch {
        /* overwrite corrupt */
      }
    }
    existing["telemetry"] = choice;
    writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
    return { ok: true, path };
  } catch (err) {
    return { ok: false, path, error: err instanceof Error ? err.message : String(err) };
  }
}

// Step 6: telemetry consent
export function renderTelemetrySection(state: TelemetryOfferState): void {
  out(divider(6, "Telemetry"));
  blank();
  if (state.alreadyOptedIn) {
    out(wrap(
      "Telemetry opt-in already active. To disable: ASHLR_TELEMETRY=off or " +
      "~/.ashlr/config.json { \"telemetry\": \"off\" }."
    ));
    out("[ASHLR_OK] telemetry-already-opted-in");
    blank();
    return;
  }
  if (state.alreadyOptedOut) {
    out(wrap(
      "Telemetry already disabled. Nothing is collected. See " +
      "docs/telemetry.md to re-enable any time."
    ));
    out("[ASHLR_OK] telemetry-already-opted-out");
    blank();
    return;
  }
  out(wrap(
    "Share anonymized session stats with the ashlr team to improve the " +
    "plugin? We collect tool-shape metrics only: tool name, raw/compact " +
    "byte counts, fall-back flags, duration. Never paths, never content, " +
    "never identifiers. Full schema: docs/telemetry.md."
  ));
  blank();
  out(wrap(
    "Default is no. You can opt out anytime by setting ASHLR_TELEMETRY=off " +
    "or running /ashlr-settings telemetry off."
  ));
  blank();
  out("[ASHLR_PROMPT: Share anonymized session stats? (y/N, default n)]");
  blank();
}

/**
 * Outcome of step 5 Ollama detection so the wizard can decide whether to
 * prompt, skip, or surface an install hint.
 */
export interface OllamaOfferState {
  /** Already configured via env: offer is skipped. */
  alreadyConfigured: boolean;
  /** `which ollama` resolved to a binary on PATH. */
  installed: boolean;
  /** Config file we'd write to if the user accepts. */
  configPath: string;
}

export function detectOllamaState(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): OllamaOfferState {
  const alreadyConfigured =
    !!(env.ASHLR_EMBED_URL && env.ASHLR_EMBED_URL.trim().length > 0) ||
    !!(env.OLLAMA_HOST && env.OLLAMA_HOST.trim().length > 0);
  let installed = false;
  try {
    // spawnSync `which` (POSIX) / `where` (Windows) synchronously — cheap and
    // avoids pulling in `bun`. We don't care about the resolved path, just the
    // exit code. A 5 s timeout prevents hangs on slow Windows CI runners.
    const { spawnSync } = require("child_process") as typeof import("child_process");
    const cmd = process.platform === "win32" ? "where" : "which";
    const res = spawnSync(cmd, ["ollama"], { stdio: "ignore", timeout: 5_000 });
    installed = res.status === 0;
  } catch {
    installed = false;
  }
  return {
    alreadyConfigured,
    installed,
    configPath: join(home, ".ashlr", "config.json"),
  };
}

/**
 * Persist ASHLR_EMBED_URL pointing at the local Ollama daemon. We write a
 * plain JSON blob the CLI bootstrap reads at startup so the flag survives
 * across sessions without the user editing their shell rc. Best-effort:
 * failures are logged and skipped so onboarding keeps flowing.
 */
export async function enableOllamaEmbeddings(
  home: string = homedir(),
): Promise<{ ok: boolean; path: string; error?: string }> {
  const path = join(home, ".ashlr", "config.json");
  try {
    mkdirSync(ashlrDir(home), { recursive: true });
    let existing: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
      } catch {
        /* overwrite corrupt */
      }
    }
    existing["ASHLR_EMBED_URL"] = "http://localhost:11434/api/embeddings";
    writeFileSync(path, JSON.stringify(existing, null, 2) + "\n");
    return { ok: true, path };
  } catch (err) {
    return { ok: false, path, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Detect whether `gh auth status` succeeds (GitHub CLI is logged in).
 * Returns true when gh is installed and authenticated, false otherwise.
 * Never throws.
 */
export function detectGhAuthState(): boolean {
  try {
    const { spawnSync } = require("child_process") as typeof import("child_process");
    // A 10 s timeout prevents hangs on Windows CI when gh is installed but
    // the auth check blocks on network (no internet access on hosted runners).
    const res = spawnSync("gh", ["auth", "status"], { stdio: "ignore", timeout: 10_000 });
    return res.status === 0;
  } catch {
    return false;
  }
}

// Step 6: Ollama offer (dense embeddings)
export function renderOllamaSection(state: OllamaOfferState): void {
  out(divider(7, "Embeddings"));
  blank();
  if (state.alreadyConfigured) {
    out(wrap(
      "Embeddings endpoint already configured via ASHLR_EMBED_URL or " +
      "OLLAMA_HOST. Skipping."
    ));
    out("[ASHLR_OK] ollama-already-configured");
    blank();
    return;
  }
  out(wrap(
    "ashlr can route grep queries through local Ollama for dense " +
    "embeddings — ~10x better semantic recall than BM25 on larger repos, " +
    "100% local, zero cost."
  ));
  blank();
  if (state.installed) {
    out(wrap(
      "Ollama detected on PATH. We can wire it up by writing " +
      "ASHLR_EMBED_URL=http://localhost:11434/api/embeddings to " +
      `${state.configPath}.`
    ));
    blank();
    out("[ASHLR_PROMPT: Enable dense embeddings via Ollama? (y/n, default y)]");
  } else {
    out(wrap(
      "Ollama not detected. Install from https://ollama.com (free, " +
      "~150MB), then re-run this wizard or execute /ashlr-ollama-setup."
    ));
    out("[ASHLR_OK] ollama-not-installed");
  }
  blank();
}

// Step 7: pro teaser
//
// Renders different content based on tier:
//   - Free users: 30-second team-genome value prop + inline "Try Pro?" prompt.
//   - Pro/Team users: team-invite tip only.
//
// Returns the conversion outcome for telemetry: "y" | "n" | "skip".
export async function renderProTeaser(
  opts: { isPro?: boolean; interactive?: boolean } = {},
): Promise<"y" | "n" | "skip"> {
  out(divider(8, "Pro plan"));
  blank();

  if (opts.isPro) {
    // Already Pro — show team-invite tip instead.
    out(wrap(
      "You're on Pro. Run /ashlr-team-invite to bring your teammates aboard " +
      "and share your genome across the whole team."
    ));
    blank();
    return "skip";
  }

  // Free tier — team-genome value prop.
  out(wrap(
    "Free ashlr builds a genome that lives on your machine. Pro lifts it " +
    "into a shared encrypted layer so every teammate learns from everyone " +
    "else's sessions — new engineers onboard into context, not silence."
  ));
  blank();
  out("Pro also includes:");
  out("  - Weekly team digest of genome learnings and streak milestones");
  out("  - Cross-machine savings sync and /ashlr-dashboard history");
  out("  - Cloud LLM summarizer (no local Ollama needed)");
  blank();
  out("Pro: $12/mo · Pro Team: $24/user/mo (min 3) · 7-day free trial, no card.");
  blank();

  // Inline conversion: prompt unless non-interactive.
  if (opts.interactive === false) {
    out("Run /ashlr-upgrade to start a 7-day free Pro trial in 90 seconds.");
    blank();
    return "skip";
  }

  out("[ASHLR_PROMPT: Try Pro free for 7 days? (y/N)]");
  const answer = await askYesNo(
    "Try Pro free for 7 days?",
    false,           // default: no
    YES_TIMEOUT_MS,
    true,            // interactive
  );

  if (answer) {
    blank();
    out(wrap(
      "Starting the upgrade flow. Launching /ashlr-upgrade — this takes " +
      "about 90 seconds."
    ));
    blank();
    out("[ASHLR_ACTION: run /ashlr-upgrade]");
    blank();
    return "y";
  } else {
    blank();
    out("No worries. Run /ashlr-upgrade any time to start your free trial.");
    blank();
    return "n";
  }
}

// Step 8: final message
export function renderFinalMessage(): void {
  out(divider(9, "Done"));
  blank();
  out("▬".repeat(WIDTH));
  out(wrap(
    "Run /ashlr-savings anytime to see running totals. The status " +
    "line at the bottom of your terminal shows live counters."
  ));
  out("Happy coding.");
  out("▬".repeat(WIDTH));
  blank();
}

// ---------------------------------------------------------------------------
// Main wizard orchestrator
// ---------------------------------------------------------------------------

export interface SkippedStep {
  step: string;
  reason: string;
  /** What to run to activate this feature. */
  hint: string;
}

export interface WizardOpts {
  interactive: boolean;
  home?: string;
  cwd?: string;
  pluginRoot?: string;
  /** Override permission installer call (for tests) */
  installPermsFn?: () => Promise<void>;
  /** Override status-line installer call (for tests) */
  installStatusLineFn?: () => Promise<void>;
  /** Override genome init call (for tests) */
  genomeInitFn?: () => Promise<void>;
  /**
   * Override the real `ashlr__read` demo subprocess (for tests). When set
   * the wizard calls this instead of spawning the MCP server.
   */
  realReadDemoFn?: (demoFile: string) => Promise<RealReadDemoResult>;
  /**
   * Override the Ollama config writer (for tests) so the real HOME isn't
   * mutated and the test can observe the call.
   */
  enableOllamaFn?: () => Promise<{ ok: boolean; path: string; error?: string }>;
}

export async function runWizard(opts: WizardOpts): Promise<void> {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const interactive = opts.interactive;

  // Telemetry helper — respects ASHLR_SESSION_LOG=0 kill switch via logEvent.
  async function emitWizardStep(
    step_name: string,
    outcome: "completed" | "skipped" | "error",
  ): Promise<void> {
    try {
      const { logEvent } = await import("../servers/_events.ts");
      await logEvent("wizard_step", {
        tool: "onboarding-wizard",
        extra: { step_name, outcome, ts: Date.now() },
      });
    } catch {
      /* best-effort — never block the wizard */
    }
  }

  // Track wizard steps that were silently skipped so we can surface them
  // in a summary at the end. Each entry has a step name, a skip reason,
  // and a one-liner on what to run to activate the feature later.
  const skipped: SkippedStep[] = [];

  // Record that wizard has started so session-start banner can show "finish setup".
  markOnboardingStarted(home);

  // --- Greeting ---
  renderGreeting();
  await emitWizardStep("intro", "completed");

  // --- Step 1: Doctor ---
  const doctor = await runDoctorCheck({ home, cwd, pluginRoot: opts.pluginRoot });
  renderDoctorOutput(doctor);
  markOnboardingStep(1, home);
  await emitWizardStep("doctor", doctor.issues.length === 0 ? "completed" : "error");

  // --- Step 2: Permissions ---
  renderPermissionsSection(doctor.allowlistOk);
  markOnboardingStep(2, home);
  if (!doctor.allowlistOk) {
    // 30-second visible countdown so the grant can't feel silent. Swapped
    // from the generic 5s askYesNo because users reported missing the fact
    // that permissions were granted on their behalf.
    const doInstall = await askYesNoWithCountdown(
      "Auto-approve all ashlr tools?",
      PERMISSIONS_COUNTDOWN_MS,
      interactive,
    );
    if (doInstall) {
      if (opts.installPermsFn) {
        await opts.installPermsFn();
      } else {
        const pluginRoot = opts.pluginRoot ?? resolvePluginRoot();
        const { installPermissions } = await import("./install-permissions.ts");
        try {
          const result = await installPermissions({ pluginRoot });
          if (result.added.length > 0) {
            out(
              wrap(
                `Added ${result.added.length} permission entr${result.added.length === 1 ? "y" : "ies"}.`
              )
            );
          } else {
            out("All ashlr permissions already present.");
          }
        } catch {
          out("[ASHLR_WARN] Permission install failed — run /ashlr-allow manually.");
        }
      }
      renderRestartCallout();
      await emitWizardStep("permissions", "completed");
    } else {
      out(wrap(
        "Skipped. Run /ashlr-allow any time to add permissions."
      ));
      skipped.push({
        step: "Permissions",
        reason: "ashlr tools require per-call approval (increases friction)",
        hint: "run /ashlr-allow to auto-approve all ashlr tools",
      });
      await emitWizardStep("permissions", "skipped");
    }
    blank();
  } else {
    await emitWizardStep("permissions", "completed");
  }

  // --- Step 3: Status line ---
  // Check if status line is already configured in ~/.claude/settings.json.
  let statusLineInstalled = false;
  try {
    const settingsPath = join(home, ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf-8");
      const s = JSON.parse(raw) as { statusLine?: unknown };
      const sl = s?.statusLine as { command?: string } | undefined;
      statusLineInstalled = !!(sl?.command && sl.command.includes("savings-status-line"));
    }
  } catch {
    /* treat as not installed */
  }

  renderStatusLineSection(statusLineInstalled);
  markOnboardingStep(3, home);

  if (!statusLineInstalled) {
    // Default ON — opt-out with "n". User presses Enter or "y" to install.
    const doStatusLine = await askYesNo(
      "Install status line?",
      true, // default yes
      YES_TIMEOUT_MS,
      interactive,
    );
    if (doStatusLine) {
      if (opts.installStatusLineFn) {
        await opts.installStatusLineFn();
      } else {
        const pluginRoot = opts.pluginRoot ?? resolvePluginRoot();
        const { spawnSync } = await import("child_process");
        const res = spawnSync(
          "bun",
          ["run", join(pluginRoot, "scripts/install-status-line.ts")],
          { stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 },
        );
        if (res.status === 0) {
          out("Status line installed.");
        } else {
          out("[ASHLR_WARN] Status line install failed — run /ashlr-allow manually.");
        }
      }
      renderRestartCallout();
      await emitWizardStep("status_line", "completed");
    } else {
      out(wrap("Skipped. Run /ashlr-status-line any time to install."));
      skipped.push({
        step: "Status line",
        reason: "live savings counter not active",
        hint: "run bun scripts/install-status-line.ts, then restart Claude Code",
      });
      await emitWizardStep("status_line", "skipped");
    }
    blank();
  } else {
    await emitWizardStep("status_line", "completed");
  }

  // --- Step 4: Live demo ---
  // Attempt the real ashlr__read call first so users see actual bytes returned.
  // Fall back to the snipCompact estimate only when spawn fails or no .ts file.
  const demoFile = findDemoFile(cwd);
  const sizeBytes = demoFile ? fileSizeBytes(demoFile) : 0;
  let payloadBytes = estimateReadPayload(sizeBytes);
  let demoReal = false;
  let demoSample: string | null = null;
  let demoError: string | null = null;
  if (demoFile) {
    // Print a status line BEFORE the spawn so users on slow laptops don't
    // sit in front of a blank terminal while Bun cold-starts the
    // efficiency-server. Without this hint a 5–10s pause looks like a hang.
    process.stdout.write("Warming up efficiency-server (cold-start can take a few seconds)...\n");
    try {
      const realFn = opts.realReadDemoFn ?? ((p: string) => runRealReadDemo(p, { pluginRoot: opts.pluginRoot }));
      const real = await realFn(demoFile);
      if (real.error || real.payloadBytes === null) {
        demoError = real.error ?? "unknown";
      } else {
        payloadBytes = real.payloadBytes;
        demoReal = true;
        demoSample = real.sample;
      }
    } catch (err) {
      demoError = err instanceof Error ? err.message : String(err);
    }
  }
  renderLiveDemoSection(demoFile, sizeBytes, payloadBytes, {
    real: demoReal,
    sample: demoSample,
    error: demoError,
  });

  // --- Step 5: Genome offer ---
  const srcFileCount = countSourceFiles(cwd);
  const ahaDemo = computeGenomeAhaDemo(demoFile, sizeBytes);
  renderGenomeSection(srcFileCount, doctor.genomePresent, ahaDemo);

  if (!doctor.genomePresent) {
    // Default flips from "yes" on healthy-size repos to "no" on small ones —
    // small/greenfield projects can opt in but won't get genomes forced on
    // them. renderGenomeSection() prints a tailored prompt for each case.
    const defaultYes = srcFileCount >= 10;
    const doGenome = await askYesNo(
      defaultYes ? "Initialize a genome?" : "Initialize a genome anyway?",
      defaultYes,
      YES_TIMEOUT_MS,
      interactive,
    );
    if (doGenome) {
      if (opts.genomeInitFn) {
        await opts.genomeInitFn();
      } else {
        const pluginRoot = opts.pluginRoot ?? resolvePluginRoot();
        out(wrap(
          "Running /ashlr-genome-init... " +
          "(this may take 15-30 seconds on large repos)"
        ));
        const { spawnSync } = await import("child_process");
        const res = spawnSync(
          "bun",
          ["run", join(pluginRoot, "scripts/genome-init.ts"), "--dir", cwd, "--minimal"],
          { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
        );
        if (res.status === 0) {
          out("Genome initialized.");
        } else {
          out("[ASHLR_WARN] Genome init failed — run /ashlr-genome-init manually.");
        }
      }
      await emitWizardStep("genome_init", "completed");
    } else {
      out(wrap("Skipped. Run /ashlr-genome-init any time to index this project."));
      await emitWizardStep("genome_init", "skipped");
    }
    blank();
  } else {
    await emitWizardStep("genome_init", "completed");
  }

  // --- Step 6: Telemetry opt-in ---
  // Strictly opt-in. Default OFF. Respect any prior explicit choice — never
  // re-prompt an already-decided user. See docs/telemetry.md for contract.
  markOnboardingStep(6, home);
  const telemetryState = detectTelemetryState(home);
  renderTelemetrySection(telemetryState);
  if (!telemetryState.alreadyOptedIn && !telemetryState.alreadyOptedOut) {
    const optIn = await askYesNo(
      "Share anonymized session stats?",
      false, // default: NO (be conservative on consent)
      YES_TIMEOUT_MS,
      interactive,
    );
    const choice: "opt-in" | "off" = optIn ? "opt-in" : "off";
    const res = await writeTelemetryChoice(choice, home);
    if (!res.ok) {
      out(`[ASHLR_WARN] Could not write telemetry choice — ${res.error ?? "unknown error"}`);
    } else if (optIn) {
      out(wrap(`Telemetry enabled. Wrote { "telemetry": "opt-in" } to ${res.path}.`));
    } else {
      out(wrap("Telemetry stays off. Nothing will be collected."));
    }
    await emitWizardStep("telemetry", optIn ? "completed" : "skipped");
    blank();
  } else {
    await emitWizardStep("telemetry", "completed");
  }

  // --- Step 7: Ollama / dense embeddings offer ---
  markOnboardingStep(7, home);
  const ollamaState = detectOllamaState(home);
  renderOllamaSection(ollamaState);
  if (!ollamaState.alreadyConfigured && !ollamaState.installed) {
    // Ollama not installed — track as a skipped step so the summary
    // surfaces it with an install hint.
    skipped.push({
      step: "Dense embeddings (Ollama)",
      reason: "Ollama not found on PATH",
      hint: "brew install ollama (or visit https://ollama.com), then re-run /ashlr-start",
    });
  }
  if (!ollamaState.alreadyConfigured && ollamaState.installed) {
    const doEnable = await askYesNo(
      "Enable dense embeddings via Ollama?",
      true,
      YES_TIMEOUT_MS,
      interactive,
    );
    if (doEnable) {
      const enableFn = opts.enableOllamaFn ?? (() => enableOllamaEmbeddings(home));
      const res = await enableFn();
      if (res.ok) {
        out(wrap(`Wrote ASHLR_EMBED_URL to ${res.path}. Restart Claude Code to pick it up.`));
      } else {
        out(`[ASHLR_WARN] Could not write Ollama config — ${res.error ?? "unknown error"}`);
      }
    } else {
      out(wrap("Skipped. Run /ashlr-ollama-setup any time to revisit."));
      skipped.push({
        step: "Dense embeddings (Ollama)",
        reason: "declined during wizard",
        hint: "run /ashlr-ollama-setup any time to enable",
      });
    }
    blank();
  }

  // Check GitHub CLI auth status and track as skipped if not logged in.
  const ghAuthed = detectGhAuthState();
  if (!ghAuthed) {
    skipped.push({
      step: "GitHub integration",
      reason: "gh CLI not authenticated",
      hint: "run: gh auth login",
    });
  }

  // --- Step 8: Pro teaser ---
  markOnboardingStep(8, home);
  // Detect tier via sync best-effort check (non-blocking; wizard never waits on network).
  let isPro = false;
  try {
    const { isProSync } = await import("../servers/_pro.ts");
    isPro = isProSync(home);
  } catch {
    /* best-effort — treat as free on any error */
  }
  const proTeaserOutcome = await renderProTeaser({ isPro, interactive });
  // Emit conversion telemetry: tool_call with tool_name "wizard_pro_pitch" or
  // "wizard_pro_team_pitch" depending on whether user is already Pro.
  try {
    const { logEvent } = await import("../servers/_events.ts");
    const toolName = isPro ? "wizard_pro_team_pitch" : "wizard_pro_pitch";
    await logEvent("tool_call", {
      tool: toolName,
      extra: { outcome: proTeaserOutcome, ts: Date.now() },
    });
  } catch {
    /* best-effort */
  }
  await emitWizardStep("pro_teaser", "completed");

  // --- Step 9: Final ---
  // Always print the loud RESTART REQUIRED callout at the end — addresses
  // UX-audit cliff #2 where users finish the wizard, ignore the soft hint,
  // and find their next tool call falls through to built-in Read/Edit/Grep.
  // Also writes ~/.ashlr/restart-required so the next SessionStart hook can
  // detect a missed restart and re-warn (same shell pid → user did not quit).
  renderRestartCallout(home);
  renderFinalMessage();
  markOnboardingCompleted(home);
  // WAD-D lead indicator: stamp the onboarding-completion timestamp on
  // stats.json so the next daily heartbeat can ship it. Best-effort —
  // never break the wizard.
  try {
    const { markOnboardingComplete } = await import("../servers/_stats.ts");
    await markOnboardingComplete();
  } catch {
    /* best-effort */
  }
  await emitWizardStep("complete", "completed");

  // Skipped-features summary: print a "Heads up" block whenever any
  // wizard steps were silently bypassed. Each item gets a one-liner on
  // what to run later so users aren't left wondering.
  if (skipped.length > 0) {
    out("▬".repeat(WIDTH));
    out("Heads up — these features aren't active yet:");
    blank();
    for (const s of skipped) {
      out(`  • ${s.step}: ${s.reason}`);
      out(`    → ${s.hint}`);
    }
    blank();
    out("▬".repeat(WIDTH));
    blank();
  }
}

// ---------------------------------------------------------------------------
// --reset mode
// ---------------------------------------------------------------------------

async function handleReset(home: string): Promise<void> {
  await deleteStamp(home);
  process.stdout.write(
    `Stamp deleted: ${stampPath(home)}\n` +
    "Next session will trigger the onboarding wizard again.\n",
  );
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const noInteractive = args.includes("--no-interactive");
  const reset = args.includes("--reset");
  const home = homedir();

  if (reset) {
    await handleReset(home);
    return 0;
  }

  try {
    await runWizard({ interactive: !noInteractive, home });
    return 0;
  } catch (err) {
    process.stderr.write(
      `ashlr onboarding-wizard: fatal error — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
