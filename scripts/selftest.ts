#!/usr/bin/env bun
/**
 * ashlr selftest — run every command against a throwaway fixture repo.
 *
 * Builds a small git repo (plus an isolated $HOME) in a temp directory, then
 * invokes the executable entry behind every `/ashlr-*` slash command and every
 * `ashlr-plugin` CLI subcommand with `--json`. A probe passes when the entry
 * exits with an expected code and produces the expected output shape — valid
 * JSON for commands with a JSON surface, clean text otherwise. Commands that
 * are agent-side only (env toggles, sub-agent fan-out, static text) are listed
 * as skipped with the reason; commands in commands/*.md with no probe declared
 * are reported as uncovered and fail the run.
 *
 * Usage:
 *   bun run scripts/selftest.ts [--json] [--only <id|command,...>] [--keep-tmp] [--timeout-ms <n>]
 *
 * Exit codes: 0 = all probes ok (skips allowed), 1 = at least one failure or
 * uncovered command, 2 = fixture/plugin-root resolution failed.
 *
 * Exported for __tests__/selftest.test.ts — keep signatures stable.
 */

import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { runWithTimeout } from "../servers/_run-with-timeout.ts";
import { c, isColorEnabled, sym } from "./ui.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProbeExpect {
  /** Allowed exit codes. Default [0]. */
  exit?: number[];
  /** stdout must parse as a single JSON value. */
  json?: boolean;
  /** stdout must contain this substring. */
  stdoutIncludes?: string;
  /** stdout+stderr combined must contain this substring. */
  outputIncludes?: string;
  /** Extra check on parsed JSON (only consulted when `json` is set). */
  checkJson?: (parsed: unknown) => string | null;
}

export type ProbeRun =
  | { kind: "script"; argv: string[] }   // `bun run <argv…>`; paths resolve against the plugin root
  | { kind: "cli"; argv: string[] }      // `bun run scripts/cli.ts <argv…>`
  | { kind: "mcp"; calls: Array<{ name: string; arguments: Record<string, unknown> }> };

export interface ProbeSpec {
  /** Unique kebab id, e.g. "ashlr-doctor:doctor". */
  id: string;
  /** User-facing commands this probe covers ("/ashlr-x" or "ashlr-plugin x"). */
  commands: string[];
  run: ProbeRun;
  /** Probe cwd inside the fixture tree. Default "repo". */
  cwd?: "repo" | "home" | "root";
  /** Optional stdin payload. */
  stdin?: string;
  timeoutMs?: number;
  expect?: ProbeExpect;
  /** Human note explaining expected-but-nonzero exits or partial coverage. */
  note?: string;
}

export interface CheckResult {
  id: string;
  commands: string[];
  status: "ok" | "fail";
  summary: string;
  exitCode: number;
  /** Whether stdout parsed as JSON; null when not attempted. */
  json: boolean | null;
  durationMs: number;
  timedOut: boolean;
  note?: string;
}

export interface CommandRow {
  name: string;
  status: "ok" | "fail" | "skipped" | "uncovered";
  probes: string[];
  reason?: string;
}

export interface Fixture {
  dir: string;
  repo: string;
  home: string;
  /** Whether `git init` + commit succeeded inside the fixture repo. */
  git: boolean;
  kept: boolean;
}

export interface SelftestReport {
  kind: "ashlr.selftest";
  schema_version: 1;
  tool: "ashlr-plugin";
  status: "ok" | "fail";
  fixture: Fixture;
  checks: CheckResult[];
  commands: CommandRow[];
  summary: {
    commands: number;
    covered: number;
    skipped: number;
    uncovered: number;
    probes: number;
    ok: number;
    failed: number;
    totalMs: number;
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** >500-byte TypeScript files so servers/bench.ts auto-discovery picks them up. */
const FIXTURE_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    { name: "ashlr-selftest-fixture", version: "0.0.0", private: true, type: "module" },
    null,
    2,
  ) + "\n",
  "tsconfig.json":
    JSON.stringify(
      { compilerOptions: { strict: true, target: "ESNext", module: "ESNext" }, include: ["src"] },
      null,
      2,
    ) + "\n",
  "README.md":
    "# ashlr selftest fixture\n\n" +
    "Throwaway repo built by `bun run scripts/selftest.ts`. Every ashlr command\n" +
    "is probed against this tree with --json. It is deleted when the run ends\n" +
    "unless --keep-tmp was passed.\n",
  "docs/guide.md":
    "# Fixture guide\n\n" +
    "src/index.ts is the entry point, src/util.ts holds helpers and\n" +
    "src/deep/nested.ts exercises nested-directory tooling.\n",
  ".ashlrcode/genome/knowledge/base.md":
    "# Fixture genome\n\n" +
    "- Conventions: strict TypeScript, ES modules, no default exports.\n" +
    "- Decisions: keep the fixture small but real so probes exercise git,\n" +
    "  genome and source-aware code paths.\n",
  "src/index.ts": [
    "import { formatBytes, memoize, retry } from \"./util\";",
    "import { deepValue } from \"./deep/nested\";",
    "",
    "export interface FixtureResult {",
    "  ok: boolean;",
    "  bytes: number;",
    "  label: string;",
    "}",
    "",
    "/** Entry point for the selftest fixture — exercised by bench + grep probes. */",
    "export async function runFixture(input: string): Promise<FixtureResult> {",
    "  const compute = memoize(async (value: string) => {",
    "    const payload = await retry(() => Promise.resolve(value.length * 2), 2);",
    "    return { ok: payload > 0, bytes: payload, label: formatBytes(payload) };",
    "  });",
    "  const direct = await compute(input);",
    "  const nested = deepValue(input);",
    "  return { ok: direct.ok && nested.length > 0, bytes: direct.bytes, label: direct.label };",
    "}",
    "",
    "export const FIXTURE_VERSION = \"0.0.0\";",
    "",
    "export function describeFixture(): string {",
    "  const parts = [\"selftest\", \"fixture\", FIXTURE_VERSION];",
    "  return parts.join(\"-\");",
    "}",
    "",
    "// Padding keeps this file above the 500-byte auto-discovery floor used by",
    "// servers/bench.ts so the /ashlr-benchmark probe has real input to score.",
    "export const fixtureNotes = [",
    "  \"small enough to build in milliseconds\",",
    "  \"large enough to trip the >500B bench threshold\",",
    "  \"a real git repo so git-aware code paths run\",",
    "];",
    "",
  ].join("\n"),
  "src/util.ts": [
    "export function formatBytes(bytes: number): string {",
    "  if (bytes < 1024) return `${bytes} B`;",
    "  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;",
    "  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;",
    "}",
    "",
    "export function memoize<A, R>(fn: (arg: A) => Promise<R>): (arg: A) => Promise<R> {",
    "  const cache = new Map<A, Promise<R>>();",
    "  return (arg: A) => {",
    "    const hit = cache.get(arg);",
    "    if (hit) return hit;",
    "    const value = fn(arg);",
    "    cache.set(arg, value);",
    "    return value;",
    "  };",
    "}",
    "",
    "export async function retry<R>(fn: () => Promise<R>, attempts: number): Promise<R> {",
    "  let lastError: unknown;",
    "  for (let i = 0; i < attempts; i++) {",
    "    try {",
    "      return await fn();",
    "    } catch (err) {",
    "      lastError = err;",
    "    }",
    "  }",
    "  throw lastError;",
    "}",
    "",
    "export function clamp(value: number, min: number, max: number): number {",
    "  return Math.min(max, Math.max(min, value));",
    "}",
    "",
    "export function splitLines(text: string): string[] {",
    "  return text.split(/\\r?\\n/).filter((line) => line.length > 0);",
    "}",
    "",
    "// The helpers above are intentionally ordinary: selftest fixtures should look",
    "// like the small libraries agents actually read, not adversarial edge cases.",
    "",
  ].join("\n"),
  "src/deep/nested.ts": [
    "/** Nested module — exercises tree/glob depth and deep-path reads. */",
    "export function deepValue(seed: string): string[] {",
    "  const out: string[] = [];",
    "  for (let i = 0; i < seed.length; i += 7) {",
    "    out.push(seed.slice(i, i + 7));",
    "  }",
    "  return out;",
    "}",
    "",
    "export const DEPTH = 3;",
    "",
    "export function describeDepth(): string {",
    "  return `nested ${DEPTH} levels below src/`;",
    "}",
    "",
    "// Sized like a real leaf module; bench discovery skips anything under 500B.",
    "export const leafNotes = [\"alpha\", \"beta\", \"gamma\", \"delta\", \"epsilon\"];",
    "",
  ].join("\n"),
};

/** Env vars stripped from probe children so results are deterministic. */
const STRIP_ENV = [
  "ASHLR_PRO_TOKEN",
  "ASHLR_TEST_TIER",
  "ASHLR_SESSION_ID",
  "ASHLR_SESSION_BUDGET_USD",
  "ASHLR_SESSION_BUDGET_TOKENS",
  "ASHLR_LAUNCH_CWD",
  "ASHLR_ALLOW_PROJECT_PATHS",
  "CLAUDE_SESSION_ID",
  "CLAUDE_PROJECT_DIR",
];

export interface FixtureOpts {
  /** Pre-created temp dir; a new mkdtemp is used when omitted. */
  dir?: string;
}

/**
 * Create the throwaway repo + isolated HOME. `git init` is best-effort: a
 * machine without git gets a plain directory and `fixture.git` reports false.
 */
export async function buildFixture(opts: FixtureOpts = {}): Promise<Fixture> {
  const dir = opts.dir ?? (await mkdtemp(join(tmpdir(), "ashlr-selftest-")));
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  for (const sub of [
    repo,
    home,
    join(home, ".ashlr"),
    join(home, ".claude"),
    // genome-init requires its target dir to exist already.
    join(dir, "genome-target"),
  ]) {
    await mkdir(sub, { recursive: true });
  }
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const abs = join(repo, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  let git = false;
  const init = await runWithTimeout({
    command: "git",
    args: ["-C", repo, "init", "-q"],
    timeoutMs: 10_000,
  });
  if (init.exitCode === 0) {
    await runWithTimeout({ command: "git", args: ["-C", repo, "config", "user.email", "selftest@ashlr.local"], timeoutMs: 10_000 });
    await runWithTimeout({ command: "git", args: ["-C", repo, "config", "user.name", "ashlr selftest"], timeoutMs: 10_000 });
    await runWithTimeout({ command: "git", args: ["-C", repo, "add", "-A"], timeoutMs: 10_000 });
    const commit = await runWithTimeout({
      command: "git",
      args: ["-C", repo, "commit", "-qm", "fixture"],
      timeoutMs: 10_000,
    });
    git = commit.exitCode === 0;
  }

  return { dir, repo, home, git, kept: false };
}

/** Probe child environment: fixture HOME, disables, and session vars stripped. */
export function probeEnv(root: string, fixture: Fixture): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || STRIP_ENV.includes(key)) continue;
    env[key] = value;
  }
  env.HOME = fixture.home;
  env.ASHLR_HOME_OVERRIDE = fixture.home;
  env.CLAUDE_PLUGIN_ROOT = root;
  env.CODEX_PLUGIN_ROOT = root;
  // Keep every probe offline and quiet: no cloud ping, no context DB, no
  // telemetry, no cloud-genome reachability, no ANSI color in matchers.
  env.ASHLR_API_URL_DISABLE = "1";
  env.ASHLR_CONTEXT_DB_DISABLE = "1";
  env.ASHLR_TELEMETRY = "off";
  env.ASHLR_CLOUD_GENOME_DISABLE = "1";
  env.ASHLR_SELFTEST = "1";
  env.NO_COLOR = "1";
  return env;
}

// ---------------------------------------------------------------------------
// Probe table — every /ashlr-* slash command + every ashlr-plugin subcommand
// ---------------------------------------------------------------------------

const PRO_T = "No Ashlr Pro token";

export const PROBES: ProbeSpec[] = [
  // ── Tier 0 ──────────────────────────────────────────────────────────────
  { id: "ashlr-start:permissions", commands: ["/ashlr-start"],
    run: { kind: "script", argv: ["scripts/install-permissions.ts", "--dry-run", "--settings", "{home}/.claude/settings.json", "--json"] } },
  { id: "ashlr-start:wizard", commands: ["/ashlr-start"], timeoutMs: 60_000,
    run: { kind: "script", argv: ["scripts/onboarding-wizard.ts", "--no-interactive", "--json"] } },
  { id: "cli:stats", commands: ["/ashlr-savings", "ashlr-plugin stats"],
    run: { kind: "cli", argv: ["stats", "--json"] },
    expect: { json: true } },
  { id: "ashlr-savings:mcp", commands: ["/ashlr-savings"], timeoutMs: 30_000,
    run: { kind: "mcp", calls: [
      { name: "ashlr__read", arguments: { path: "src/index.ts" } },
      { name: "ashlr__savings", arguments: {} },
    ] },
    note: "real tools/call over stdio — the command's actual code path" },
  { id: "ashlr-dashboard:dashboard", commands: ["/ashlr-dashboard"],
    run: { kind: "script", argv: ["scripts/savings-dashboard.ts", "--json"] } },
  { id: "ashlr-dashboard:log", commands: ["/ashlr-dashboard"],
    run: { kind: "script", argv: ["scripts/session-log-report.ts", "--json"] } },
  { id: "ashlr-doctor:doctor", commands: ["/ashlr-doctor"], timeoutMs: 90_000,
    run: { kind: "script", argv: ["scripts/doctor.ts", "--json"] },
    expect: { exit: [0, 1], json: true,
      checkJson: (p) => (p as { kind?: string }).kind === "ashlr.doctor" ? null : "kind is not ashlr.doctor" },
    note: "exit 0 = healthy, 1 = diagnostics found; both are completed reports" },
  { id: "ashlr-doctor:errors", commands: ["/ashlr-doctor"],
    run: { kind: "script", argv: ["scripts/errors-report.ts", "--json"] },
    note: "covers the --errors flag" },

  // ── Tier 1 ──────────────────────────────────────────────────────────────
  { id: "ashlr-resume", commands: ["/ashlr-resume"],
    run: { kind: "script", argv: ["scripts/session-resume.ts", "--json"] } },
  { id: "ashlr-handoff", commands: ["/ashlr-handoff"],
    run: { kind: "script", argv: ["scripts/savings-dashboard.ts", "--handoff", "--json"] } },
  { id: "ashlr-brief:tier", commands: ["/ashlr-brief"],
    run: { kind: "script", argv: ["scripts/check-tier.ts", "--json"] },
    note: "covers the --project tier gate; brief.json writes are agent-side" },
  { id: "ashlr-brief:eval", commands: ["/ashlr-brief"], timeoutMs: 60_000,
    run: { kind: "script", argv: ["scripts/brief-eval.ts", "--json"] },
    expect: { json: true } },
  { id: "ashlr-tier", commands: ["/ashlr-tier"],
    run: { kind: "script", argv: ["scripts/check-tier.ts", "--json"] } },
  { id: "ashlr-allow", commands: ["/ashlr-allow"],
    run: { kind: "script", argv: ["scripts/install-permissions.ts", "--settings", "{home}/.claude/settings.json", "--json"] } },

  // ── Tier 2: genome / team ───────────────────────────────────────────────
  { id: "ashlr-genome-init", commands: ["/ashlr-genome-init"],
    run: { kind: "script", argv: ["scripts/genome-init.ts", "--dir", "{tmp}/genome-target", "--minimal", "--json"] } },
  { id: "ashlr-genome-keygen", commands: ["/ashlr-genome-keygen"],
    run: { kind: "script", argv: ["scripts/genome-keygen.ts", "--dry-run", "--json"] },
    expect: { exit: [0, 2] },
    note: `exit 2 is the designed refusal without a Pro token ("${PRO_T}")` },
  { id: "ashlr-genome-loop", commands: ["/ashlr-genome-loop"],
    run: { kind: "script", argv: ["scripts/genome-auto-consolidate.ts", "--dir", "{repo}", "--json"] } },
  { id: "ashlr-genome-push", commands: ["/ashlr-genome-push"],
    run: { kind: "script", argv: ["scripts/genome-cloud-push.ts", "--dry-run", "--json"] } },
  { id: "ashlr-genome-rewrap", commands: ["/ashlr-genome-rewrap"],
    run: { kind: "script", argv: ["scripts/genome-rewrap.ts", "--json"] },
    expect: { exit: [0, 2], outputIncludes: PRO_T },
    note: "fixture has no Pro token — the clean refusal is the expected outcome" },
  { id: "ashlr-genome-team-init", commands: ["/ashlr-genome-team-init"],
    run: { kind: "script", argv: ["scripts/genome-team-init.ts", "--json"] },
    expect: { exit: [0, 2], outputIncludes: PRO_T },
    note: "fixture has no Pro token — the clean refusal is the expected outcome" },

  // ── Tier 3: power ───────────────────────────────────────────────────────
  { id: "ashlr-orchestrate", commands: ["/ashlr-orchestrate"],
    run: { kind: "script", argv: ["scripts/cli-orchestrate.ts", "selftest", "--json"] },
    expect: { exit: [0, 1], outputIncludes: "Pro or Team" },
    note: "fixture is free-tier — the Pro/Team gate refusal is the expected outcome" },
  { id: "ashlr-orchestrate-status", commands: ["/ashlr-orchestrate-status"],
    run: { kind: "script", argv: ["scripts/cli-orchestrate-status.ts", "--json"] },
    expect: { json: true } },
  { id: "ashlr-benchmark", commands: ["/ashlr-benchmark"], timeoutMs: 45_000,
    run: { kind: "script", argv: ["servers/bench.ts", "--dir", "{repo}/src", "--json"] } },
  { id: "ashlr-hook-timings", commands: ["/ashlr-hook-timings"],
    run: { kind: "script", argv: ["scripts/hook-timings-report.ts", "--json"] } },
  { id: "ashlr-report-crash", commands: ["/ashlr-report-crash"],
    run: { kind: "script", argv: ["scripts/report-crash.ts", "--dry-run", "--json"] },
    expect: { exit: [0, 1] },
    note: "exit 1 means no crash dumps exist in the clean fixture — correct" },
  { id: "ashlr-status:context", commands: ["/ashlr-status"],
    run: { kind: "script", argv: ["scripts/context-status.ts", "--json"] } },
  { id: "ashlr-status:telemetry", commands: ["/ashlr-status"],
    run: { kind: "script", argv: ["scripts/telemetry-status.ts", "--json"] } },
  { id: "ashlr-ollama-setup", commands: ["/ashlr-ollama-setup"], timeoutMs: 45_000,
    run: { kind: "script", argv: ["scripts/ollama-setup.ts", "--json"] },
    expect: { exit: [0, 1, 2], stdoutIncludes: "ashlr ollama-setup" },
    note: "diagnostic — exit code reflects this machine's Ollama state, not failure" },
  { id: "ashlr-settings:install", commands: ["/ashlr-settings"],
    run: { kind: "script", argv: ["scripts/install-status-line.ts", "--json"] },
    note: "writes statusLine into the fixture's own .claude/settings.json" },
  { id: "ashlr-settings:render", commands: ["/ashlr-settings"],
    run: { kind: "script", argv: ["scripts/savings-status-line.ts", "--json"] },
    stdin: "{}" },
  { id: "ashlr-legend", commands: ["/ashlr-legend"],
    run: { kind: "script", argv: ["scripts/print-legend.ts"] },
    expect: { stdoutIncludes: "status-line legend" },
    note: "plain-text legend — the command renders stdout verbatim" },

  // ── ashlr-plugin CLI subcommands ────────────────────────────────────────
  { id: "cli:tools", commands: ["ashlr-plugin tools"],
    run: { kind: "cli", argv: ["tools", "--json"] },
    expect: { json: true,
      checkJson: (p) => ((p as { count?: number }).count ?? 0) >= 40 ? null : "tools.count < 40" } },
  { id: "cli:codex-doctor", commands: ["ashlr-plugin codex-doctor", "ashlr-plugin doctor"],
    run: { kind: "cli", argv: ["codex-doctor", "--json"] },
    expect: { json: true } },
  { id: "cli:codex-install", commands: ["ashlr-plugin codex-install"],
    run: { kind: "cli", argv: ["codex-install", "--dry-run", "--json"] },
    expect: { json: true } },
  { id: "cli:codex-start", commands: ["ashlr-plugin codex-start"],
    run: { kind: "cli", argv: ["codex-start", "--json"] },
    expect: { json: true } },
  { id: "cli:codex-resume", commands: ["ashlr-plugin codex-resume"],
    run: { kind: "cli", argv: ["codex-resume", "--json"] },
    expect: { json: true } },
  { id: "cli:codex-end", commands: ["ashlr-plugin codex-end"],
    run: { kind: "cli", argv: ["codex-end", "--json"] },
    expect: { json: true } },
  { id: "cli:genome-refresh", commands: ["ashlr-plugin genome-refresh"],
    run: { kind: "cli", argv: ["genome-refresh", "--dry-run", "--json"] },
    expect: { json: true } },
  { id: "cli:mcp", commands: ["ashlr-plugin mcp"], timeoutMs: 30_000,
    run: { kind: "mcp", calls: [] },
    expect: { json: true },
    note: "initialize + tools/list over real stdio — the `mcp` subcommand's server" },
  { id: "cli:version", commands: ["ashlr-plugin version"],
    run: { kind: "cli", argv: ["version"] },
    expect: { stdoutIncludes: "ashlr-plugin" },
    note: "plain-text version — the one CLI output that is intentionally not JSON" },
  { id: "cli:help", commands: ["ashlr-plugin help"],
    run: { kind: "cli", argv: ["--help"] },
    expect: { exit: [0], outputIncludes: "usage:" } },
];

/**
 * Commands whose real work happens inside the host agent (env toggles, prompt
 * bookkeeping, sub-agent fan-out) or on external services — there is no local
 * script entry to probe. Listed so every shipped command is accounted for.
 */
export const SKIPPED_COMMANDS: Record<string, string> = {
  "/ashlr-budget": "session env-var command (ASHLR_SESSION_BUDGET_*) — no script entry",
  "/ashlr-compact": "agent-side analysis of ~/.ashlr/session-history — no script entry",
  "/ashlr-eco-mode": "session env-var command (ASHLR_ECO) — no script entry",
  "/ashlr-fleet": "explains Phantom mod commands (/top, /peers, /send) — static text, no plugin script",
  "/ashlr-help": "prints a static command table — nothing to execute",
  "/ashlr-leaderboard": "agent-side edit of ~/.ashlr/config.json; the sync itself is Pro-gated",
  "/ashlr-parallelize": "in-agent fan-out of Task sub-agents — no script entry",
  "/ashlr-selftest": "the selftest itself — this report is its output",
  "/ashlr-spawn": "in-agent delegation patterns — no script entry",
  "/ashlr-team-invite": "hosted invite flow — needs an account and network access",
  "/ashlr-tour": "guided in-agent walkthrough — no script entry",
  "/ashlr-update": "git-pulls the installed plugin — mutating and needs network",
  "/ashlr-upgrade": "checkout + activation flow — needs an account and network",
  "/goal": "runs the external `ashlr` fleet binary (ashlr-stack), not a plugin script",
  "/loop": "runs the external `ashlr` fleet binary (ashlr-stack), not a plugin script",
  "ashlr-plugin selftest": "the selftest itself — this report is its output",
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function resolvePluginRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..");
  return existsSync(join(root, ".claude-plugin", "plugin.json")) ? root : null;
}

function substitute(argv: string[], root: string, fixture: Fixture): string[] {
  return argv.map((a) =>
    a
      .replaceAll("{root}", root)
      .replaceAll("{repo}", fixture.repo)
      .replaceAll("{home}", fixture.home)
      .replaceAll("{tmp}", fixture.dir),
  );
}

function excerpt(s: string, max = 140): string {
  const first = s.trim().split("\n").find((l) => l.trim().length > 0) ?? "";
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

export interface RawRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

async function runMcpProbe(
  root: string,
  fixture: Fixture,
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
  timeoutMs: number,
): Promise<RawRun> {
  const initReq = {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ashlr-selftest", version: "1" } },
  };
  const listReq = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const reqs = calls.map((call, i) => ({
    jsonrpc: "2.0", id: 100 + i, method: "tools/call",
    params: { name: call.name, arguments: call.arguments },
  }));
  const payload = [initReq, listReq, ...reqs].map((r) => JSON.stringify(r)).join("\n") + "\n";

  return runWithTimeout({
    command: bunBinary(),
    args: ["run", join(root, "servers", "_router.ts")],
    cwd: fixture.repo,
    env: probeEnv(root, fixture),
    input: payload,
    timeoutMs,
  });
}

/** Evaluate an MCP transcript: tools/list count + per-call result/isError. */
export function evalMcpTranscript(
  stdout: string,
  calls: Array<{ name: string }>,
): { tools: number; callErrors: string[] } {
  let tools = -1;
  const callErrors: string[] = [];
  const seen = new Set<number>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: {
      id?: number;
      result?: { tools?: unknown[]; isError?: boolean; content?: unknown };
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (msg.id === 2 && Array.isArray(msg.result?.tools)) tools = msg.result.tools.length;
    if (typeof msg.id === "number" && msg.id >= 100) {
      seen.add(msg.id);
      const call = calls[msg.id - 100];
      const label = call?.name ?? String(msg.id);
      if (msg.error) callErrors.push(`${label}: ${msg.error.message ?? "rpc error"}`);
      else if (msg.result?.isError) callErrors.push(`${label}: tool returned isError`);
      else if (!msg.result) callErrors.push(`${label}: no result`);
    }
  }
  calls.forEach((call, i) => {
    if (!seen.has(100 + i)) callErrors.push(`${call.name}: no response`);
  });
  return { tools, callErrors };
}

export function evalExpect(
  probe: ProbeSpec,
  raw: RawRun,
): { status: "ok" | "fail"; summary: string; json: boolean | null } {
  const expect = probe.expect ?? {};
  const allowedExit = expect.exit ?? [0];
  const isMcp = probe.run.kind === "mcp";
  const calls = probe.run.kind === "mcp" ? probe.run.calls : [];

  if (raw.timedOut) {
    return { status: "fail", summary: `timed out after ${probe.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, json: null };
  }
  if (isMcp) {
    if (raw.exitCode !== 0) return { status: "fail", summary: `router exited ${raw.exitCode}: ${excerpt(raw.stderr)}`, json: false };
    const { tools, callErrors } = evalMcpTranscript(raw.stdout, calls);
    if (tools < 0) return { status: "fail", summary: "no tools/list response from router", json: false };
    if (tools < 40) return { status: "fail", summary: `tools/list returned ${tools} tools (< 40)`, json: true };
    if (callErrors.length > 0) return { status: "fail", summary: callErrors.join("; "), json: true };
    const callsSummary = calls.length > 0 ? `${calls.length} tools/call ok` : "tools/list only";
    return { status: "ok", summary: `${tools} tools listed; ${callsSummary}`, json: true };
  }

  if (!allowedExit.includes(raw.exitCode)) {
    const errBit = raw.stderr.trim() ? ` — ${excerpt(raw.stderr)}` : "";
    return {
      status: "fail",
      summary: `exit ${raw.exitCode} (expected ${allowedExit.join("/")})${errBit}`,
      json: null,
    };
  }

  let json: boolean | null = null;
  if (expect.json) {
    try {
      const parsed = JSON.parse(raw.stdout) as unknown;
      json = true;
      const problem = expect.checkJson?.(parsed) ?? null;
      if (problem) return { status: "fail", summary: `invalid JSON payload: ${problem}`, json };
    } catch {
      return { status: "fail", summary: `stdout is not JSON: ${excerpt(raw.stdout) || "(empty)"}`, json: false };
    }
  }
  if (expect.stdoutIncludes && !raw.stdout.includes(expect.stdoutIncludes)) {
    return { status: "fail", summary: `stdout missing "${expect.stdoutIncludes}"`, json };
  }
  const combined = `${raw.stdout}\n${raw.stderr}`;
  if (expect.outputIncludes && !combined.includes(expect.outputIncludes)) {
    return { status: "fail", summary: `output missing "${expect.outputIncludes}"`, json };
  }

  const parts = [`exit ${raw.exitCode}${raw.exitCode !== 0 ? " (expected)" : ""}`];
  if (json === true) parts.push("valid JSON");
  return { status: "ok", summary: parts.join(" · "), json };
}

const DEFAULT_TIMEOUT_MS = 30_000;

function bunBinary(): string {
  const base = process.execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return base === "bun" || base === "bun.exe" || base.startsWith("bun-") ? process.execPath : "bun";
}

export async function runProbe(root: string, fixture: Fixture, probe: ProbeSpec): Promise<CheckResult> {
  const start = Date.now();
  const timeoutMs = probe.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cwd = probe.cwd === "home" ? fixture.home : probe.cwd === "root" ? root : fixture.repo;

  let raw: RawRun;
  if (probe.run.kind === "mcp") {
    raw = await runMcpProbe(root, fixture, probe.run.calls, timeoutMs);
  } else {
    const argv = substitute(probe.run.argv, root, fixture);
    const args =
      probe.run.kind === "cli"
        ? ["run", join(root, "scripts", "cli.ts"), ...argv]
        : ["run", join(root, argv[0]!), ...argv.slice(1)];
    raw = await runWithTimeout({
      command: bunBinary(),
      args,
      cwd,
      env: probeEnv(root, fixture),
      input: probe.stdin,
      timeoutMs,
    });
  }

  const verdict = evalExpect(probe, raw);
  return {
    id: probe.id,
    commands: probe.commands,
    status: verdict.status,
    summary: verdict.summary,
    exitCode: raw.exitCode,
    json: verdict.json,
    durationMs: Date.now() - start,
    timedOut: raw.timedOut,
    ...(probe.note ? { note: probe.note } : {}),
  };
}

// ---------------------------------------------------------------------------
// Coverage: every commands/*.md file must be probed or explicitly skipped
// ---------------------------------------------------------------------------

export async function listCommandFiles(root: string): Promise<string[]> {
  const entries = await readdir(join(root, "commands"));
  return entries.filter((name) => name.endsWith(".md")).sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

/**
 * Discover `ashlr-plugin` subcommands by reading the `case "…"` labels in
 * cli.ts's main switch, so a newly added subcommand shows up as uncovered
 * here instead of drifting past the selftest silently. `-`-prefixed labels
 * are flag aliases (--version, -h), not subcommands.
 */
export async function listCliSubcommands(root: string): Promise<string[]> {
  const src = await readFile(join(root, "scripts", "cli.ts"), "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/case "([^"]+)"/g)) {
    if (!m[1]!.startsWith("-")) names.add(m[1]!);
  }
  return [...names].sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}

export function commandCoverage(
  commandFiles: string[],
  cliSubs: string[],
  probes: ProbeSpec[] = PROBES,
  skipped: Record<string, string> = SKIPPED_COMMANDS,
): CommandRow[] {
  const rows: CommandRow[] = [];
  const names = [...commandFiles.map((f) => `/${f.replace(/\.md$/, "")}`), ...cliSubs.map((s) => `ashlr-plugin ${s}`)];
  for (const name of names) {
    const covering = probes.filter((p) => p.commands.includes(name));
    if (covering.length > 0) {
      rows.push({ name, status: "ok", probes: covering.map((p) => p.id) });
    } else if (skipped[name]) {
      rows.push({ name, status: "skipped", probes: [], reason: skipped[name] });
    } else {
      rows.push({
        name,
        status: "uncovered",
        probes: [],
        reason: "no selftest probe declared — add one to PROBES or a reason to SKIPPED_COMMANDS in scripts/selftest.ts",
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Top-level run
// ---------------------------------------------------------------------------

export interface RunOpts {
  json?: boolean;
  /** Run only these probe ids or command names (comma-separated). */
  only?: string[];
  keepTmp?: boolean;
  timeoutMs?: number;
  root?: string;
  onProgress?: (line: string) => void;
}

export async function runSelftest(opts: RunOpts = {}): Promise<{ report: SelftestReport; code: number }> {
  const started = Date.now();
  const root = opts.root ?? resolvePluginRoot();
  if (!root) {
    throw new Error("could not locate plugin root (no .claude-plugin/plugin.json above scripts/)");
  }

  const fixture = await buildFixture();
  fixture.kept = opts.keepTmp === true;
  opts.onProgress?.(`fixture: ${fixture.dir}${fixture.git ? "" : " (no git)"}`);

  // --only selects probes by id or by any command they cover.
  const only = opts.only && opts.only.length > 0 ? new Set(opts.only) : null;
  const matches = (p: ProbeSpec) =>
    !only ||
    only.has(p.id) ||
    only.has(p.id.split(":").pop()!) ||
    p.commands.some((cmd) => only.has(cmd) || only.has(cmd.replace(/^\//, "")) || only.has(`/${cmd.replace(/^\//, "")}`));
  const selected = PROBES.filter(matches);

  const checks: CheckResult[] = [];
  for (const spec of selected) {
    const probe = opts.timeoutMs && !spec.timeoutMs ? { ...spec, timeoutMs: opts.timeoutMs } : spec;
    const result = await runProbe(root, fixture, probe);
    checks.push(result);
    opts.onProgress?.(`${result.status === "ok" ? sym.check : sym.cross} ${probe.id} — ${result.summary} (${result.durationMs}ms)`);
  }

  const commandFiles = await listCommandFiles(root);
  const cliSubs = await listCliSubcommands(root);
  const rows = commandCoverage(commandFiles, cliSubs);
  // Fold probe outcomes into command rows and emit uncovered rows.
  const byCommand = new Map<string, CheckResult[]>();
  for (const check of checks) {
    for (const cmd of check.commands) {
      const list = byCommand.get(cmd) ?? [];
      list.push(check);
      byCommand.set(cmd, list);
    }
  }
  for (const row of rows) {
    const related = byCommand.get(row.name) ?? [];
    if (row.status === "ok" && related.some((r) => r.status === "fail")) row.status = "fail";
    // A covered command with zero executed probes only happens under --only.
    if (row.status === "ok" && only && related.length === 0) {
      row.status = "skipped";
      row.reason = "filtered out by --only";
    }
  }

  const failed = checks.filter((c) => c.status === "fail");
  const uncovered = rows.filter((r) => r.status === "uncovered");
  const report: SelftestReport = {
    kind: "ashlr.selftest",
    schema_version: 1,
    tool: "ashlr-plugin",
    status: failed.length === 0 && uncovered.length === 0 ? "ok" : "fail",
    fixture,
    checks,
    commands: rows,
    summary: {
      commands: rows.length,
      covered: rows.filter((r) => r.status === "ok" || r.status === "fail").length,
      skipped: rows.filter((r) => r.status === "skipped").length,
      uncovered: uncovered.length,
      probes: checks.length,
      ok: checks.filter((c) => c.status === "ok").length,
      failed: failed.length,
      totalMs: Date.now() - started,
    },
  };

  if (!fixture.kept) {
    await rm(fixture.dir, { recursive: true, force: true });
  }

  return { report, code: report.status === "ok" ? 0 : 1 };
}

// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

export function formatReport(report: SelftestReport): string {
  const s = report.summary;
  const glyph = (ok: boolean) => (isColorEnabled() ? (ok ? c.green(sym.check) : c.red(sym.cross)) : ok ? sym.check : sym.cross);
  const skipGlyph = isColorEnabled() ? c.dim(sym.dot) : sym.dot;

  const lines: string[] = [];
  lines.push(
    `ashlr selftest · ${s.commands} commands · ${s.probes} probes` +
      ` · fixture ${report.fixture.dir}${report.fixture.git ? "" : " (no git)"}${report.fixture.kept ? " (kept)" : ""}`,
  );
  lines.push("");

  const checksByCommand = new Map<string, CheckResult[]>();
  for (const check of report.checks) {
    for (const cmd of check.commands) {
      const list = checksByCommand.get(cmd) ?? [];
      list.push(check);
      checksByCommand.set(cmd, list);
    }
  }

  for (const row of report.commands) {
    const related = checksByCommand.get(row.name) ?? [];
    if (row.status === "skipped") {
      lines.push(`${skipGlyph} ${row.name.padEnd(28)} skipped — ${row.reason ?? "no probe"}`);
    } else if (row.status === "uncovered") {
      lines.push(`${glyph(false)} ${row.name.padEnd(28)} uncovered — ${row.reason}`);
    } else {
      for (const check of related) {
        const suffix = check.note && check.status === "ok" ? ` · ${check.note}` : "";
        lines.push(
          `${glyph(check.status === "ok")} ${row.name.padEnd(28)} ${check.id} — ${check.summary} (${check.durationMs}ms)${suffix}`,
        );
      }
      if (related.length === 0) lines.push(`${glyph(row.status !== "fail")} ${row.name.padEnd(28)} covered (filtered out by --only)`);
    }
  }

  lines.push("");
  const tail = `${s.ok} passed · ${s.failed} failed · ${s.skipped} skipped · ${s.uncovered} uncovered · ${(s.totalMs / 1000).toFixed(1)}s`;
  lines.push(isColorEnabled() ? (s.failed + s.uncovered > 0 ? c.red(tail) : c.green(tail)) : tail);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function parseSelftestArgs(argv: string[]): RunOpts & { help: boolean } {
  const opts: RunOpts & { help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") opts.json = true;
    else if (a === "--keep-tmp") opts.keepTmp = true;
    else if (a === "--only" && argv[i + 1]) opts.only = argv[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--only=")) opts.only = a.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--timeout-ms" && argv[i + 1]) opts.timeoutMs = Number(argv[++i]);
    else if (a.startsWith("--timeout-ms=")) opts.timeoutMs = Number(a.slice(13));
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

export const SELFTEST_USAGE = `usage: bun run scripts/selftest.ts [--json] [--only <id|command,...>] [--keep-tmp] [--timeout-ms <n>]
  run every ashlr command's entry point against a throwaway fixture repo.
  --json       print the full report as JSON
  --only       run a subset (probe id or command name, comma-separated)
  --keep-tmp   keep the fixture directory under $TMPDIR for inspection
  --timeout-ms default per-probe timeout (default ${DEFAULT_TIMEOUT_MS})
`;

async function main(): Promise<number> {
  const opts = parseSelftestArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(SELFTEST_USAGE);
    return 0;
  }
  let report: SelftestReport;
  let code: number;
  try {
    ({ report, code } = await runSelftest(opts));
  } catch (err) {
    process.stderr.write(`ashlr selftest: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatReport(report) + "\n");
  }
  return code;
}

if (import.meta.main) {
  process.exit(await main());
}
