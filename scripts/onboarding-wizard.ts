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
const TOTAL_STEPS = 7;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function stampPath(home: string = homedir()): string {
  return join(home, ".ashlr", STAMP_FILENAME);
}

export function ashlrDir(home: string = homedir()): string {
  return join(home, ".ashlr");
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

// Step 3: live demo
export function renderLiveDemoSection(
  demoFile: string | null,
  sizeBytes: number,
  payloadBytes: number,
  opts: { real?: boolean; sample?: string | null; error?: string | null } = {},
): void {
  out(divider(3, "Live demo"));
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

// Step 4: genome offer
export function renderGenomeSection(
  srcFileCount: number,
  genomePresent: boolean,
): void {
  out(divider(4, "Genome"));
  blank();
  if (genomePresent) {
    out(wrap("Genome already initialized in this project. You're all set."));
    out("[ASHLR_OK] genome-present");
    blank();
    return;
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
        "in the current directory. Genome benefits compound with repo size, " +
        "so the savings on a small/greenfield project are modest right now — " +
        "but initializing one seeds the index for when the project grows."
      )
    );
    blank();
    out("[ASHLR_PROMPT: Initialize a genome anyway? (y/n, default n)]");
    blank();
    return;
  }

  out(
    wrap(
      `Found ${srcFileCount} source files. A genome compresses grep results ` +
      "~4x by pre-indexing symbol definitions so the model retrieves " +
      "targeted excerpts instead of raw file content."
    )
  );
  blank();
  out("[ASHLR_PROMPT: Initialize a genome for this project? (y/n, default y)]");
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

// Step 5: Ollama offer (dense embeddings)
export function renderOllamaSection(state: OllamaOfferState): void {
  out(divider(5, "Embeddings"));
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

// Step 6: pro teaser
export function renderProTeaser(): void {
  out(divider(6, "Pro plan"));
  blank();
  out(wrap(
    "Free works forever. Pro ($12/mo) adds cloud sync across machines " +
    "and a hosted LLM so you don't need a local Ollama install for " +
    "genome summarization."
  ));
  blank();
  out("Start Pro in 90 seconds — run /ashlr-upgrade from any Claude Code session.");
  blank();
  out("Learn more: plugin.ashlr.ai/pricing");
  blank();
}

// Step 7: final message
export function renderFinalMessage(): void {
  out(divider(7, "Done"));
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

  // Track wizard steps that were silently skipped so we can surface them
  // in a summary at the end. Each entry has a step name, a skip reason,
  // and a one-liner on what to run to activate the feature later.
  const skipped: SkippedStep[] = [];

  // Record that wizard has started so session-start banner can show "finish setup".
  markOnboardingStarted(home);

  // --- Greeting ---
  renderGreeting();

  // --- Step 1: Doctor ---
  const doctor = await runDoctorCheck({ home, cwd, pluginRoot: opts.pluginRoot });
  renderDoctorOutput(doctor);
  markOnboardingStep(1, home);

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
                `Added ${result.added.length} permission entr${result.added.length === 1 ? "y" : "ies"}. ` +
                "Restart Claude Code to apply."
              )
            );
          } else {
            out("All ashlr permissions already present.");
          }
        } catch {
          out("[ASHLR_WARN] Permission install failed — run /ashlr-allow manually.");
        }
      }
    } else {
      out(wrap(
        "Skipped. Run /ashlr-allow any time to add permissions."
      ));
      skipped.push({
        step: "Permissions",
        reason: "ashlr tools require per-call approval (increases friction)",
        hint: "run /ashlr-allow to auto-approve all ashlr tools",
      });
    }
    blank();
  }

  // --- Step 3: Live demo ---
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

  // --- Step 4: Genome offer ---
  const srcFileCount = countSourceFiles(cwd);
  renderGenomeSection(srcFileCount, doctor.genomePresent);

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
    } else {
      out(wrap("Skipped. Run /ashlr-genome-init any time to index this project."));
    }
    blank();
  }

  // --- Step 5: Ollama / dense embeddings offer ---
  markOnboardingStep(5, home);
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

  // --- Step 6: Pro teaser ---
  renderProTeaser();

  // --- Step 7: Final ---
  renderFinalMessage();
  markOnboardingCompleted(home);

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
