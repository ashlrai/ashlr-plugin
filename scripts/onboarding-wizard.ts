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

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "fs";
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
const TOTAL_STEPS = 6;

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
// wizard script is self-contained and can run without MCP active.
export function estimateReadPayload(sizeBytes: number): number {
  if (sizeBytes <= 4096) return sizeBytes; // small file: full content
  // snipCompact: ~30 head lines + ~20 tail lines ≈ 50 lines * ~60 chars = 3000
  // plus elision marker. Conservative estimate: 40% of original, min 3KB.
  return Math.max(3000, Math.round(sizeBytes * 0.35));
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

  out(`File:         ${shortName}`);
  out(`Disk size:    ${sizeBytes.toLocaleString()} bytes`);
  out(`ashlr__read:  ~${payloadBytes.toLocaleString()} bytes returned (~${pct}% of file)`);
  out(`Saved:        ~${saved.toLocaleString()} bytes not sent to the model`);
  blank();
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
    out(
      wrap(
        `Only ${srcFileCount} source file${srcFileCount === 1 ? "" : "s"} found ` +
        "in the current directory. Genome is most useful on larger repos " +
        "(10+ source files). Skipping."
      )
    );
    out("[ASHLR_OK] genome-skipped-small-repo");
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

// Step 5: pro teaser
export function renderProTeaser(): void {
  out(divider(5, "Pro plan"));
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

// Step 6: final message
export function renderFinalMessage(): void {
  out(divider(6, "Done"));
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

export interface WizardOpts {
  interactive: boolean;
  home?: string;
  cwd?: string;
  pluginRoot?: string;
  /** Override permission installer call (for tests) */
  installPermsFn?: () => Promise<void>;
  /** Override genome init call (for tests) */
  genomeInitFn?: () => Promise<void>;
}

export async function runWizard(opts: WizardOpts): Promise<void> {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const interactive = opts.interactive;

  // --- Greeting ---
  renderGreeting();

  // --- Step 1: Doctor ---
  const doctor = await runDoctorCheck({ home, cwd, pluginRoot: opts.pluginRoot });
  renderDoctorOutput(doctor);

  // --- Step 2: Permissions ---
  renderPermissionsSection(doctor.allowlistOk);
  if (!doctor.allowlistOk) {
    const doInstall = await askYesNo(
      "Auto-approve all ashlr tools?",
      true,
      YES_TIMEOUT_MS,
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
    }
    blank();
  }

  // --- Step 3: Live demo ---
  const demoFile = findDemoFile(cwd);
  const sizeBytes = demoFile ? fileSizeBytes(demoFile) : 0;
  const payloadBytes = estimateReadPayload(sizeBytes);
  renderLiveDemoSection(demoFile, sizeBytes, payloadBytes);

  // --- Step 4: Genome offer ---
  const srcFileCount = countSourceFiles(cwd);
  renderGenomeSection(srcFileCount, doctor.genomePresent);

  if (!doctor.genomePresent && srcFileCount >= 10) {
    const doGenome = await askYesNo(
      "Initialize a genome?",
      true,
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

  // --- Step 5: Pro teaser ---
  renderProTeaser();

  // --- Step 6: Final ---
  renderFinalMessage();
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
