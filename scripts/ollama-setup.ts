#!/usr/bin/env bun
/**
 * ashlr ollama-setup — diagnose + guided install of Ollama for `--summarize`.
 *
 * Flow:
 *   1. Check Ollama is on PATH and that the daemon is reachable.
 *   2. List installed models via /api/tags.
 *   3. If no recommended (fast, summarization-quality) model is present,
 *      either auto-install the top pick (when --yes / ASHLR_OLLAMA_AUTO=1)
 *      or print the exact pull command for the user.
 *   4. Smoke-test the chosen model with a 1-sentence prompt under 30 s.
 *   5. Warn if the user only has 20B+ parameter models — those time out.
 *
 * Zero external dependencies. ANSI colors inline so this script stays
 * independent from scripts/ui.ts (owned by a sibling feature).
 *
 * Exit codes:
 *   0  everything works (installed + running + fast model ready + smoke-test passed)
 *   1  actionable user-facing problem (not installed / not running / pull needed / smoke-test failed)
 *   2  internal error (unexpected exception)
 */
/* eslint-disable no-console */

import { spawn } from "bun";

// ---------------------------------------------------------------------------
// Colored output (zero deps, respects NO_COLOR / FORCE_COLOR / !isTTY)
// ---------------------------------------------------------------------------

function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return typeof process.stdout?.isTTY === "boolean" ? process.stdout.isTTY : false;
}

const ESC = "\u001b[";
function wrap(open: string, close: string, s: string): string {
  return colorEnabled() ? `${ESC}${open}m${s}${ESC}${close}m` : s;
}
const c = {
  red: (s: string): string => wrap("31", "39", s),
  green: (s: string): string => wrap("32", "39", s),
  yellow: (s: string): string => wrap("33", "39", s),
  cyan: (s: string): string => wrap("36", "39", s),
  magenta: (s: string): string => wrap("35", "39", s),
  dim: (s: string): string => wrap("2", "22", s),
  bold: (s: string): string => wrap("1", "22", s),
};

// ✓ / ✗ / ⚠ / ℹ glyphs; ASCII fallback when colors are off (safer in pipes).
function glyph(kind: "ok" | "fail" | "warn" | "info"): string {
  const unicode = { ok: "✓", fail: "✗", warn: "⚠", info: "ℹ" };
  const ascii = { ok: "[ok]", fail: "[x]", warn: "[!]", info: "[i]" };
  const g = colorEnabled() ? unicode[kind] : ascii[kind];
  if (!colorEnabled()) return g;
  const color = { ok: c.green, fail: c.red, warn: c.yellow, info: c.cyan }[kind];
  return color(g);
}

function printOk(msg: string): void {
  console.log(`${glyph("ok")} ${msg}`);
}
function printFail(msg: string): void {
  console.log(`${glyph("fail")} ${msg}`);
}
function printWarn(msg: string): void {
  console.log(`${glyph("warn")} ${msg}`);
}
function printInfo(msg: string): void {
  console.log(`${glyph("info")} ${msg}`);
}
function printFix(cmd: string): void {
  const label = colorEnabled() ? c.yellow("fix:") : "fix:";
  const body = colorEnabled() ? c.dim(cmd) : cmd;
  console.log(`    ${label} ${body}`);
}

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

export const OLLAMA_BASE_URL = "http://localhost:11434";
const TAGS_TIMEOUT_MS = 3000;
const SMOKE_TIMEOUT_MS = 30000;

export interface RecommendedModel {
  name: string;
  sizeGB: number;
  note: string;
}

/**
 * Recommended models in preference order — fast AND good enough for
 * 2–3 sentence summarization on CPU / small GPUs.
 */
export const RECOMMENDED_MODELS: RecommendedModel[] = [
  { name: "llama3.2:3b", sizeGB: 2.0, note: "recommended default — fastest, good quality" },
  { name: "llama3.2:1b", sizeGB: 1.3, note: "tiny, acceptable fallback" },
  { name: "qwen2.5:3b", sizeGB: 2.0, note: "alternative" },
  { name: "phi3.5:3.8b", sizeGB: 2.2, note: "alternative" },
];

/** Roughly parse Ollama's "llama3.2:3b" style tag into a parameter count in B. */
export function estimateParamsB(modelName: string): number | null {
  // e.g. "llama3.2:3b", "gemma4:26b", "qwen2.5:3b-instruct", "phi3.5:3.8b"
  const m = modelName.match(/:([0-9]+(?:\.[0-9]+)?)b/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** True if the model is ≥20B parameters and so likely too slow for summarization. */
export function isSlowModel(modelName: string): boolean {
  const p = estimateParamsB(modelName);
  return p !== null && p >= 20;
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

function installInstructions(): string[] {
  const plat = process.platform;
  if (plat === "darwin") {
    return [
      "macOS — install via Homebrew:",
      "    brew install ollama",
      "  or download the app from:",
      "    https://ollama.com/download",
    ];
  }
  if (plat === "linux") {
    return [
      "Linux — one-line install:",
      "    curl -fsSL https://ollama.com/install.sh | sh",
    ];
  }
  return [
    "Download Ollama for your platform:",
    "    https://ollama.com/download",
  ];
}

function startInstructions(): string[] {
  const plat = process.platform;
  if (plat === "darwin") {
    return [
      "Start the Ollama daemon:",
      "    ollama serve            # run in a separate terminal",
      "  or, if installed via Homebrew:",
      "    brew services start ollama",
    ];
  }
  return [
    "Start the Ollama daemon:",
    "    ollama serve            # run in a separate terminal",
    "  or (systemd):",
    "    systemctl --user start ollama",
  ];
}

// ---------------------------------------------------------------------------
// Ollama probes
// ---------------------------------------------------------------------------

/** True if `ollama` is on PATH. */
export async function hasOllamaOnPath(): Promise<boolean> {
  try {
    const proc = spawn({
      cmd: ["which", "ollama"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out.length > 0 && proc.exitCode === 0;
  } catch {
    return false;
  }
}

export interface OllamaModelInfo {
  name: string;
  sizeBytes?: number;
}

export interface TagsResult {
  running: boolean;
  models: OllamaModelInfo[];
  error?: string;
}

/** Fetch /api/tags. Returns `running: false` if the daemon is unreachable. */
export async function fetchTags(
  baseUrl = OLLAMA_BASE_URL,
  timeoutMs = TAGS_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<TagsResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: ctrl.signal });
    if (!res.ok) return { running: false, models: [], error: `HTTP ${res.status}` };
    const j = (await res.json()) as { models?: Array<{ name: string; size?: number }> };
    const models = (j.models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size }));
    return { running: true, models };
  } catch (err) {
    return { running: false, models: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(t);
  }
}

/** Run `ollama pull <model>` and stream stdout/stderr through. */
async function pullModel(model: string): Promise<boolean> {
  printInfo(`pulling ${c.bold(model)} — this may take a few minutes...`);
  try {
    const proc = spawn({
      cmd: ["ollama", "pull", model],
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch (err) {
    printFail(`failed to start ollama pull: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export interface SmokeTestResult {
  ok: boolean;
  durationMs: number;
  error?: string;
  sampleResponse?: string;
}

/**
 * Send a 1-sentence prompt to the model and verify it responds in <30s.
 * Uses /api/chat with stream:false for simplicity.
 */
export async function smokeTest(
  model: string,
  baseUrl = OLLAMA_BASE_URL,
  timeoutMs = SMOKE_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<SmokeTestResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetchImpl(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: "Reply with exactly one short sentence: 'Ollama is working.'",
          },
        ],
        stream: false,
        options: { num_predict: 40, temperature: 0 },
      }),
      signal: ctrl.signal,
    });
    const durationMs = Date.now() - start;
    if (!res.ok) {
      return { ok: false, durationMs, error: `HTTP ${res.status}` };
    }
    const j = (await res.json()) as { message?: { content?: string } };
    const content = j.message?.content?.trim() ?? "";
    if (!content) {
      return { ok: false, durationMs, error: "empty response" };
    }
    return { ok: true, durationMs, sampleResponse: content };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    const error = ctrl.signal.aborted ? `timed out after ${timeoutMs}ms` : msg;
    return { ok: false, durationMs, error };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Policy helpers
// ---------------------------------------------------------------------------

/** Pick the first recommended model that's available locally, or null. */
export function pickRecommendedAvailable(
  installed: OllamaModelInfo[],
  recs: RecommendedModel[] = RECOMMENDED_MODELS,
): string | null {
  const set = new Set(installed.map((m) => m.name));
  for (const r of recs) {
    if (set.has(r.name)) return r.name;
  }
  return null;
}

/** True if every installed model has ≥20B params. */
export function hasOnlySlowModels(installed: OllamaModelInfo[]): boolean {
  if (installed.length === 0) return false;
  return installed.every((m) => isSlowModel(m.name));
}

export interface CliArgs {
  yes: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    yes: process.env.ASHLR_OLLAMA_AUTO === "1",
    help: false,
  };
  for (const a of argv) {
    if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function printHelp(): void {
  console.log(
    `ashlr ollama-setup — diagnose Ollama for the --summarize flag\n\n` +
      `Usage: bun run scripts/ollama-setup.ts [--yes]\n\n` +
      `Options:\n` +
      `  --yes, -y          Auto-pull the recommended model (llama3.2:3b, ~2 GB)\n` +
      `                     without prompting. Same effect as ASHLR_OLLAMA_AUTO=1.\n` +
      `  --help, -h         Show this message.\n\n` +
      `Exit codes:\n` +
      `  0  Ollama installed, running, recommended model present, smoke-test passed\n` +
      `  1  actionable problem (not installed / not running / no model / smoke-test failed)\n` +
      `  2  internal error`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(args: CliArgs): Promise<number> {
  const header = "ashlr ollama-setup";
  console.log(colorEnabled() ? c.bold(c.magenta(header)) : header);
  console.log("");

  // --- 1. Is ollama on PATH? -----------------------------------------------
  const onPath = await hasOllamaOnPath();

  // --- 2. Is daemon reachable? ---------------------------------------------
  // Do this regardless of PATH — Ollama.app on macOS binds 127.0.0.1:11434
  // even when the CLI isn't on $PATH, so the daemon probe is the real test.
  const tags = await fetchTags();

  if (!onPath && !tags.running) {
    printFail("Ollama is not installed (not on PATH and daemon unreachable)");
    console.log("");
    for (const l of installInstructions()) console.log(`  ${l}`);
    console.log("");
    printInfo("after installing, re-run: /ashlr-ollama-setup");
    return 1;
  }

  if (!tags.running) {
    printOk("Ollama CLI found on PATH");
    printFail(
      `Ollama daemon not reachable at ${OLLAMA_BASE_URL}${tags.error ? ` (${tags.error})` : ""}`,
    );
    console.log("");
    for (const l of startInstructions()) console.log(`  ${l}`);
    console.log("");
    printInfo("after starting the daemon, re-run: /ashlr-ollama-setup");
    return 1;
  }

  printOk("Ollama is installed and running");

  // --- 3. List installed models --------------------------------------------
  const installed = tags.models;
  if (installed.length === 0) {
    printWarn("no models installed");
  } else {
    const names = installed.map((m) => m.name).join(", ");
    printOk(`${installed.length} model${installed.length === 1 ? "" : "s"} installed: ${c.dim(names)}`);
  }

  // --- 4. Is a recommended model present? ----------------------------------
  const chosen = pickRecommendedAvailable(installed);

  // If we have nothing recommended, offer/auto-install the top pick.
  let modelForSmokeTest: string | null = chosen;
  if (!chosen) {
    const topPick = RECOMMENDED_MODELS[0];
    printWarn(`no fast recommended model installed (${topPick.name} is the recommended default)`);
    console.log("");
    console.log(`  ${c.bold("recommended models")} (pick one):`);
    for (const r of RECOMMENDED_MODELS) {
      const sizeStr = `~${r.sizeGB} GB`;
      console.log(`    ${c.cyan(r.name.padEnd(16))} ${c.dim(sizeStr.padEnd(10))} ${c.dim(r.note)}`);
    }
    console.log("");

    if (args.yes) {
      printInfo(`--yes / ASHLR_OLLAMA_AUTO=1 set — auto-pulling ${topPick.name} (~${topPick.sizeGB} GB)`);
      const ok = await pullModel(topPick.name);
      if (!ok) {
        printFail(`ollama pull ${topPick.name} failed`);
        printFix(`ollama pull ${topPick.name}`);
        return 1;
      }
      printOk(`pulled ${topPick.name}`);
      modelForSmokeTest = topPick.name;
    } else {
      printInfo("to install the recommended model, run:");
      printFix(`ollama pull ${topPick.name}`);
      console.log("");
      printInfo("or re-run with --yes to install automatically:");
      printFix("bun run scripts/ollama-setup.ts --yes");
      // Warn about slow-only models before exiting so the user sees it now.
      if (hasOnlySlowModels(installed)) {
        console.log("");
        printWarn(
          `your installed models are all ≥20B params (${installed.map((m) => m.name).join(", ")}) — ` +
            `expect --summarize to time out. Adding a 3B model strongly recommended.`,
        );
      }
      return 1;
    }
  } else {
    printOk(`recommended model available: ${c.bold(chosen)}`);
  }

  // --- 5. Warn about slow-only installs ------------------------------------
  // Even when we have a recommended model, if the user also has giant ones it's
  // worth noting — genome-init's auto-picker prefers the recommended, but users
  // doing manual `ollama run <big>` will feel the pain.
  const slowOnly = hasOnlySlowModels(installed) && !chosen;
  if (slowOnly) {
    printWarn(
      `every installed model is ≥20B params — summarization will likely time out. ` +
        `Install a small model: ollama pull ${RECOMMENDED_MODELS[0].name}`,
    );
  }

  // --- 6. Smoke test -------------------------------------------------------
  if (!modelForSmokeTest) {
    // Shouldn't happen given above branches, but guard.
    printFail("no model available for smoke test");
    return 1;
  }
  printInfo(`smoke-testing ${c.bold(modelForSmokeTest)} (30 s timeout)...`);
  const smoke = await smokeTest(modelForSmokeTest);
  if (!smoke.ok) {
    printFail(`smoke test failed: ${smoke.error ?? "unknown error"} (${smoke.durationMs} ms)`);
    if (isSlowModel(modelForSmokeTest)) {
      printFix(`ollama pull ${RECOMMENDED_MODELS[0].name}  # ${modelForSmokeTest} is too large for fast summaries`);
    } else {
      printFix(`ollama run ${modelForSmokeTest}  # try interactively to see the error`);
    }
    return 1;
  }
  const secs = (smoke.durationMs / 1000).toFixed(1);
  printOk(`smoke test passed in ${secs}s`);
  if (smoke.sampleResponse) {
    const preview = smoke.sampleResponse.length > 120
      ? smoke.sampleResponse.slice(0, 117) + "..."
      : smoke.sampleResponse;
    console.log(`    ${c.dim("→")} ${c.dim(preview)}`);
  }

  // --- Done ---------------------------------------------------------------
  console.log("");
  const ok = colorEnabled() ? c.bold(c.green("ready")) : "ready";
  console.log(`${ok} — /ashlr-genome-init --summarize will use ${c.bold(modelForSmokeTest)}`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  try {
    return await run(args);
  } catch (err) {
    printFail(`internal error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
