#!/usr/bin/env bun
/**
 * cli-orchestrate.ts — entry point invoked by /ashlr-orchestrate.
 *
 * Pipeline:
 *   1. Resolve tier (isProSync + optional ASHLR_TEST_TIER override).
 *   2. Either parse --yaml <path> OR auto-expand the goal via Track A.
 *   3. Render the DAG via Track B and print to stdout.
 *   4. Confirm via stdin (y/n/e), unless --auto-confirm.
 *   5. Run the graph via Track B and print a summary.
 *
 * Designed for dependency injection: tests pass overrides for isProSync,
 * the expander, the runner, stdin, and stdout/stderr writers so they can
 * assert every branch without spawning real subprocesses.
 *
 * Targets the Track A schema landed in main: discriminated-union returns
 * for fromYaml + validateTaskGraph; TaskGraph requires id/createdAt/
 * handoffs/metadata; tier is restricted to "pro" | "team" (free is gated
 * before we ever reach the expander).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve as resolvePath } from "path";

import { isProSync } from "../servers/_pro.ts";
import {
  fromYaml,
  toYaml,
  validateTaskGraph,
  type TaskGraph,
} from "../servers/_task-graph.ts";
import { renderTaskGraph } from "../servers/_task-graph-render.ts";
import { expandToTaskGraph } from "./orchestrate-expand.ts";
import { runTaskGraph, type RunResult } from "./orchestrate-run.ts";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  goal: string | null;
  scope: string | null;
  yamlPath: string | null;
  autoConfirm: boolean;
  dryRun: boolean;
  tierOverride: "free" | "pro" | "team" | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    goal: null,
    scope: null,
    yamlPath: null,
    autoConfirm: false,
    dryRun: false,
    tierOverride: null,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scope") out.scope = argv[++i] ?? null;
    else if (a === "--yaml") out.yamlPath = argv[++i] ?? null;
    else if (a === "--auto-confirm") out.autoConfirm = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--tier") {
      const v = argv[++i];
      if (v === "free" || v === "pro" || v === "team") out.tierOverride = v;
    } else if (a && !a.startsWith("--")) {
      positional.push(a);
    }
  }
  if (positional.length > 0) out.goal = positional.join(" ");
  return out;
}

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

export type Tier = "free" | "pro" | "team";

export function resolveTier(
  env: NodeJS.ProcessEnv = process.env,
  isPro: () => boolean = isProSync,
  argOverride?: Tier | null,
): Tier {
  if (argOverride) return argOverride;
  // Test escape hatch — keeps the smoke test self-contained without
  // requiring a real ~/.ashlr/pro-token-cache.json. Mirrors the
  // ASHLR_PRO_ASSUME pattern in servers/_pro.ts.
  const testTier = env["ASHLR_TEST_TIER"];
  if (testTier === "free" || testTier === "pro" || testTier === "team") {
    return testTier;
  }
  return isPro() ? "pro" : "free";
}

// ---------------------------------------------------------------------------
// Confirmation prompt
// ---------------------------------------------------------------------------

export type Choice = "y" | "n" | "e";

export interface PromptOptions {
  readLine: () => Promise<string>;
}

export async function readConfirmation(opts: PromptOptions): Promise<Choice> {
  const raw = (await opts.readLine()).trim().toLowerCase();
  if (raw.startsWith("y")) return "y";
  if (raw.startsWith("e")) return "e";
  return "n";
}

function defaultStdinReadLine(): Promise<string> {
  return new Promise((resolveP) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolveP(buf.slice(0, nl));
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// ---------------------------------------------------------------------------
// Edit-path YAML scratch file
// ---------------------------------------------------------------------------

export function writeEditScratch(
  graph: TaskGraph,
  home: string = homedir(),
  now: () => Date = () => new Date(),
): string {
  const dir = join(home, ".ashlr");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const id = now().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `orchestrate-edit-${id}.yaml`);
  writeFileSync(path, toYaml(graph), "utf-8");
  return path;
}

// ---------------------------------------------------------------------------
// Summary formatter
// ---------------------------------------------------------------------------

export function formatSummary(result: RunResult): string {
  const lines: string[] = [];
  lines.push("Run summary");
  lines.push(`  ok:        ${result.ok}`);
  lines.push(`  duration:  ${result.totalDurationMs}ms`);
  lines.push(`  tokens:    ${result.totalTokens}`);
  lines.push("  nodes:");
  for (const n of result.nodes) {
    const tag = n.ok ? "[ok]  " : "[fail]";
    lines.push(
      `    ${tag}${n.id.padEnd(12)} (${n.durationMs}ms, ${n.tokens} tokens)${
        n.error ? ` — ${n.error}` : ""
      }`,
    );
  }
  lines.push("completed");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface MainDeps {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
  isPro?: () => boolean;
  expand?: typeof expandToTaskGraph;
  run?: typeof runTaskGraph;
  readLine?: () => Promise<string>;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  readFile?: (p: string) => string;
  home?: () => string;
  now?: () => Date;
  isTTY?: boolean;
}

export async function main(deps: MainDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? (() => process.cwd());
  const out = deps.stdout ?? ((s) => process.stdout.write(s));
  const err = deps.stderr ?? ((s) => process.stderr.write(s));
  const expand = deps.expand ?? expandToTaskGraph;
  const run = deps.run ?? runTaskGraph;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const home = deps.home ?? homedir;
  const now = deps.now ?? (() => new Date());
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);

  const args = parseArgs(deps.argv);
  const tier = resolveTier(env, deps.isPro, args.tierOverride);

  // 1. Tier gate
  if (tier === "free") {
    err("Orchestration requires Pro or Team. Run /ashlr-upgrade.\n");
    return 1;
  }

  // 2. Load or expand
  let graph: TaskGraph;
  if (args.yamlPath) {
    const absPath = resolvePath(args.yamlPath);
    let raw: string;
    try {
      raw = readFile(absPath);
    } catch (e) {
      err(`Could not read YAML file: ${absPath}\n`);
      err(`  ${(e as Error).message}\n`);
      return 1;
    }
    const parsed = fromYaml(raw);
    if (!parsed.ok) {
      err(`YAML parse error:\n`);
      for (const e of parsed.errors) err(`  ${e}\n`);
      return 1;
    }
    const v = validateTaskGraph(parsed.graph);
    if (!v.ok) {
      err(`Graph validation failed:\n`);
      for (const e of v.errors) err(`  ${e}\n`);
      return 1;
    }
    graph = v.graph;
  } else {
    if (!args.goal) {
      err(
        'Usage: ashlr-orchestrate "<goal>" [--scope <path>] [--yaml <path>] [--auto-confirm] [--dry-run]\n',
      );
      return 1;
    }
    graph = await expand({
      goal: args.goal,
      scope: args.scope ?? cwd(),
      tier: tier === "team" ? "team" : "pro",
    });
  }

  // 3. Render preview
  out(renderTaskGraph(graph, { color: isTTY }));
  out("\n");

  // 4. Confirm
  if (!args.autoConfirm) {
    out("Press y to execute, n to cancel, e to edit YAML.\n");
    const choice = await readConfirmation({
      readLine: deps.readLine ?? defaultStdinReadLine,
    });
    if (choice === "n") {
      out("cancelled\n");
      return 0;
    }
    if (choice === "e") {
      const path = writeEditScratch(graph, home(), now);
      out(`Wrote graph to ${path}\n`);
      out(`Edit and re-run with --yaml ${path}\n`);
      return 0;
    }
  }

  // 5. Run + summary
  const result = await run({
    graph,
    dryRun: args.dryRun,
    cwd: args.scope ?? cwd(),
  });
  out(formatSummary(result));
  out("\n");
  return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const isDirectInvocation =
  // Bun's import.meta.main is true for direct `bun run` invocations.
  // Fall back to argv check for safety.
  (import.meta as ImportMeta & { main?: boolean }).main === true ||
  (typeof process !== "undefined" && process.argv[1]?.endsWith("cli-orchestrate.ts"));

if (isDirectInvocation) {
  main({ argv: process.argv.slice(2) })
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`fatal: ${(e as Error).message}\n`);
      process.exit(2);
    });
}
