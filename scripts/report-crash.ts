#!/usr/bin/env bun
/**
 * ashlr report-crash — opt-in CLI that uploads a recent crash dump to the
 * ashlr-plugin maintainer backend. Reads from ~/.ashlr/crashes/YYYY-MM-DD.jsonl
 * (already redacted by servers/_crash-dump.ts).
 *
 * Flow:
 *   1. Load the most-recent record across the last 7 days of dumps (or a
 *      specific file via --dump). --all sends every record from the window.
 *   2. Preview on stderr so the user sees what will leave their machine.
 *   3. Confirm (or skip with --yes / --dry-run).
 *   4. POST to $ASHLR_CRASH_UPLOAD_URL (or --endpoint; defaults to
 *      https://api.ashlr.ai/crash-report).
 *   5. Print the returned reportId so users can cite it in issues.
 *
 * Exits:
 *   0 success (or dry-run / --stdout)
 *   1 no crashes found
 *   2 declined
 *   3 network error
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const DEFAULT_ENDPOINT = "https://api.ashlr.ai/crash-report";

function home(): string {
  return process.env.HOME ?? homedir();
}
function crashesDir(): string {
  return join(home(), ".ashlr", "crashes");
}
function proTokenFile(): string {
  return join(home(), ".ashlr", "pro-token");
}

interface CrashRecord {
  ts: string;
  tool: string;
  message: string;
  stack?: string;
  args: string;
  node?: string;
  bun?: string;
}

interface Args {
  dump?: string;
  all: boolean;
  dryRun: boolean;
  stdout: boolean;
  yes: boolean;
  endpoint?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { all: false, dryRun: false, stdout: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--all") out.all = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--stdout") out.stdout = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--dump") out.dump = argv[++i];
    else if (a === "--endpoint") out.endpoint = argv[++i];
  }
  return out;
}

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function listRecentDumpFiles(): string[] {
  const dir = crashesDir();
  if (!existsSync(dir)) return [];
  const today = new Date();
  const keep = new Set<string>();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getTime() - i * 86_400_000);
    keep.add(d.toISOString().slice(0, 10));
  }
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => n.endsWith(".jsonl") && keep.has(n.slice(0, 10)))
    .sort()
    .reverse()
    .map((n) => join(dir, n));
}

function readDump(path: string): CrashRecord[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const out: CrashRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as CrashRecord); } catch { /* skip malformed */ }
  }
  return out;
}

function collectRecords(args: Args): CrashRecord[] {
  if (args.dump) return readDump(args.dump);
  const files = listRecentDumpFiles();
  const all: CrashRecord[] = [];
  for (const f of files) all.push(...readDump(f));
  all.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  return args.all ? all : all.slice(0, 1);
}

function previewRecord(r: CrashRecord): string {
  const firstStackLine = r.stack?.split("\n")[0] ?? "";
  const lines = [
    `  ts:      ${r.ts}`,
    `  tool:    ${r.tool}`,
    `  message: ${r.message}`,
  ];
  if (firstStackLine) lines.push(`  stack:   ${firstStackLine} …`);
  lines.push(`  args:    ${r.args}`);
  if (r.node || r.bun) lines.push(`  runtime: node=${r.node ?? "?"} bun=${r.bun ?? "?"}`);
  return lines.join("\n");
}

async function submit(
  endpoint: string,
  record: CrashRecord,
  proToken: string | null,
): Promise<{ reportId: string; receivedAt: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (proToken) headers["authorization"] = `Bearer ${proToken}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      record,
      pluginVersion: process.env.ASHLR_PLUGIN_VERSION ?? "unknown",
      platform: process.platform,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as { reportId: string; receivedAt: string };
}

async function promptYes(q: string): Promise<boolean> {
  process.stderr.write(q);
  for await (const chunk of process.stdin) {
    const ans = chunk.toString().trim().toLowerCase();
    return ans === "" || ans === "y" || ans === "yes";
  }
  return false;
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    err("Usage: report-crash [--dump <path>] [--all] [--dry-run] [--stdout] [--yes] [--endpoint <url>]");
    return 0;
  }

  const records = collectRecords(args);
  if (records.length === 0) {
    err(args.dump ? `No records in ${args.dump}.` : `No crashes in ${crashesDir()} for the last 7 days.`);
    return 1;
  }

  if (args.stdout) {
    for (const r of records) process.stdout.write(JSON.stringify(r) + "\n");
    return 0;
  }

  err(`Found ${records.length} crash${records.length === 1 ? "" : "es"}:`);
  for (const r of records) err("\n" + previewRecord(r));

  if (args.dryRun) {
    err("\n--dry-run: nothing uploaded.");
    return 0;
  }

  if (!args.yes) {
    const ok = await promptYes("\nUpload these to the ashlr-plugin maintainer? [Y/n] ");
    if (!ok) { err("Declined."); return 2; }
  }

  const endpoint = args.endpoint ?? process.env.ASHLR_CRASH_UPLOAD_URL ?? DEFAULT_ENDPOINT;
  if (!endpoint) {
    err("Upload endpoint is empty. Set ASHLR_CRASH_UPLOAD_URL or pass --endpoint.");
    return 3;
  }

  const tokenPath = proTokenFile();
  const proToken = existsSync(tokenPath)
    ? (readFileSync(tokenPath, "utf-8").trim() || null)
    : null;

  const results: Array<{ reportId: string; ts: string }> = [];
  for (const r of records) {
    try {
      const resp = await submit(endpoint, r, proToken);
      results.push({ reportId: resp.reportId, ts: r.ts });
    } catch (e) {
      err(`upload failed for crash at ${r.ts}: ${(e as Error).message}`);
      return 3;
    }
  }

  err(`\nUploaded ${results.length} crash${results.length === 1 ? "" : "es"}.`);
  for (const { reportId, ts } of results) {
    err(`  report-id: ${reportId}  (crash ${ts})`);
  }
  return 0;
}

// Run only when invoked directly, not under import (for tests).
if (import.meta.main) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      err(`fatal: ${(e as Error).message}`);
      process.exit(3);
    });
}
