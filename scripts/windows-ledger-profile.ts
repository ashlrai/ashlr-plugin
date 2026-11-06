/** Bounded synthetic diagnosis only. This never produces a full-test receipt. */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsProcessEnv } from "./fleet-ghosts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const LEDGER = new URL("../hooks/_hook-timing-ledger.ts", import.meta.url).href;
export const PROFILE_OPERATIONS = ["mkdirSync", "chmodSync", "openSync", "writeFileSync", "fsyncSync", "closeSync", "renameSync", "rmSync", "lstatSync", "fstatSync", "statSync", "existsSync", "readFileSync", "readdirSync", "readSync"] as const;
const CATEGORIES = ["parent", "lock-directory", "lock-owner", "ledger", "other"] as const;
type Metric = { calls: number; errors: number; ms: number };
type Metrics = Record<string, Metric>;

// Every wrapper invokes the original operation once with the same arguments,
// return value and exception. Paths/FDs are classified locally, never emitted.
async function worker() {
  const { mock } = await import("bun:test");
  const fs = await import("fs");
  const actual = { ...fs };
  const ledgerPath = process.env.ASHLR_PROFILE_LEDGER!;
  const id = Number(process.env.ASHLR_PROFILE_WRITER);
  if (!ledgerPath || !Number.isInteger(id) || id < 0 || id >= 12) throw new Error("invalid synthetic profiler context");
  const key = (value: string) => process.platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value;
  const parent = key(dirname(ledgerPath)), lock = key(`${ledgerPath}.lock`), leaf = key(ledgerPath);
  const descriptors = new Map<number, string>();
  const metrics: Metrics = {};
  function category(arg: unknown): string {
    if (typeof arg === "number") return descriptors.get(arg) ?? "other";
    if (typeof arg !== "string") return "other";
    const value = key(arg);
    return value === parent ? "parent" : value === lock ? "lock-directory"
      : value.startsWith(lock + "/") ? "lock-owner" : value === leaf ? "ledger" : "other";
  }
  function record(name: string, began: number, failed = false) {
    const row = metrics[name] ??= { calls: 0, errors: 0, ms: 0 };
    row.calls++; row.errors += Number(failed); row.ms += performance.now() - began;
  }
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of PROFILE_OPERATIONS) {
    const original = actual[name] as (...args: any[]) => any;
    wrapped[name] = (...args: any[]) => {
      const type = category(args[0]), started = performance.now();
      let failed = true;
      try {
        const result = Reflect.apply(original, undefined, args);
        if (name === "openSync") descriptors.set(result, type);
        if (name === "closeSync") descriptors.delete(args[0]);
        failed = false; return result;
      } finally { record(`${type}:${name}`, started, failed); }
    };
  }
  const originalWait = Atomics.wait;
  Atomics.wait = ((...args: Parameters<typeof Atomics.wait>) => {
    const began = performance.now();
    try { return Reflect.apply(originalWait, Atomics, args); }
    finally { record("lock-wait:Atomics.wait", began); }
  }) as typeof Atomics.wait;
  mock.module("fs", () => wrapped);
  const { appendHookTimingBatch } = await import(LEDGER);
  // Exclude import/setup work from the append measurements.
  for (const name of Object.keys(metrics)) delete metrics[name];
  const started = performance.now();
  let contended = 0, appendMs = 0, retrySleepMs = 0;
  console.log(JSON.stringify({ progress: 0 }));
  for (let row = 0; row < 80; row++) {
    const batch = JSON.stringify({ ts: new Date().toISOString(), hook: `child-${id}`, tool: "Read", durationMs: row, outcome: "ok" }) + "\n";
    let written = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const began = performance.now();
      const result = appendHookTimingBatch(ledgerPath, batch);
      appendMs += performance.now() - began;
      if (result === "written") { written = true; break; }
      if (result === "failed") throw new Error("synthetic ledger write failed");
      contended++; const sleepStarted = performance.now(); await Bun.sleep(5); retrySleepMs += performance.now() - sleepStarted;
    }
    if (!written) throw new Error("synthetic ledger retry exhaustion");
    if ((row + 1) % 8 === 0) console.log(JSON.stringify({ progress: row + 1 }));
  }
  for (const metric of Object.values(metrics)) metric.ms = Math.round(metric.ms * 1000) / 1000;
  console.log(JSON.stringify({ writer: id, written: 80, contended, appendMs: Math.round(appendMs),
    elapsedMs: Math.round(performance.now() - started), retrySleepMs: Math.round(retrySleepMs), metrics }));
}

export function parseLedgerProfileOutput(text: string) {
  if (Buffer.byteLength(text) > 8192) throw new Error("synthetic profile output exceeds bound");
  const lines = text.trim().split(/\r?\n/);
  if (lines.length !== 12) throw new Error("synthetic profile is incomplete");
  for (let i = 0; i < 11; i++) {
    const row = JSON.parse(lines[i]!);
    if (Object.keys(row).join() !== "progress" || row.progress !== i * 8) throw new Error("synthetic progress changed");
  }
  const result = JSON.parse(lines[11]!);
  const keys = ["writer", "written", "contended", "appendMs", "elapsedMs", "retrySleepMs", "metrics"];
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(keys.sort()) ||
      !Number.isInteger(result.writer) || result.writer < 0 || result.writer >= 12 || result.written !== 80 ||
      !Number.isInteger(result.contended) || result.contended < 0 || result.contended > 16000 ||
      !Number.isInteger(result.appendMs) || result.appendMs < 0 || !Number.isInteger(result.elapsedMs) || result.elapsedMs < 0 ||
      !Number.isInteger(result.retrySleepMs) || result.retrySleepMs < 0 || result.retrySleepMs > 60_000 ||
      !result.metrics || typeof result.metrics !== "object" || Array.isArray(result.metrics)) throw new Error("invalid synthetic completion");
  const allowed = new Set<string>(["lock-wait:Atomics.wait", ...CATEGORIES.flatMap(c => PROFILE_OPERATIONS.map(op => `${c}:${op}`))]);
  if (Object.keys(result.metrics).length < 1 || Object.keys(result.metrics).length > allowed.size) throw new Error("missing synthetic metrics");
  for (const [name, value] of Object.entries(result.metrics)) {
    const metric = value as Metric;
    if (!allowed.has(name) || !metric || JSON.stringify(Object.keys(metric).sort()) !== '["calls","errors","ms"]' ||
        !Number.isSafeInteger(metric.calls) || metric.calls <= 0 || metric.calls > 1_000_000 ||
        !Number.isSafeInteger(metric.errors) || metric.errors < 0 || metric.errors > metric.calls ||
        !Number.isFinite(metric.ms) || metric.ms < 0 || metric.ms > 60_000) throw new Error("invalid synthetic metric");
  }
  return result as { writer: number; written: number; contended: number; appendMs: number; elapsedMs: number; retrySleepMs: number; metrics: Metrics };
}

export async function profileLedgerWrites() {
  const root = mkdtempSync(join(tmpdir(), "ashlr-ledger-profile-"));
  const identity = lstatSync(root, { bigint: true });
  const directory = join(root, ".ashlr"), path = join(directory, "hook-timings.jsonl");
  mkdirSync(directory, { mode: 0o700 });
  const env = { ...windowsProcessEnv(), PATH: process.env.PATH, HOME: root, USERPROFILE: root,
    CI: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ASHLR_PROFILE_LEDGER: path };
  const started = performance.now();
  const spawnWriter = (id: number) => Bun.spawn({
    cmd: [process.execPath, SELF, "--worker"], cwd: ROOT, env: { ...env, ASHLR_PROFILE_WRITER: String(id) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const children: ReturnType<typeof spawnWriter>[] = [];
  const settled = new Set<ReturnType<typeof spawnWriter>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rowsAt19Seconds: number | null = null;
  const progressTimer = setTimeout(() => {
    try {
      const st = lstatSync(path);
      if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size <= 16 * 1024 * 1024) {
        rowsAt19Seconds = readFileSync(path).reduce((n, byte) => n + Number(byte === 10), 0);
      }
    } catch { /* Missing observation is unknown, never fabricated progress. */ }
  }, 19_000);
  async function bounded(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
        if (size > 8192) throw new Error("synthetic child output exceeds bound"); chunks.push(next.value); }
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } finally { reader.releaseLock(); }
  }
  try {
    // Partial spawn failure still enters the same owned-child cleanup.
    for (let id = 0; id < 12; id++) {
      const child = spawnWriter(id); children.push(child);
      void child.exited.then(() => { settled.add(child); }, () => {});
    }
    const results = await Promise.race([
      Promise.all(children.map(async (child, id) => {
        const [output, errors, code] = await Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]);
        if (code !== 0 || errors) throw new Error("synthetic profile child failed");
        const result = parseLedgerProfileOutput(output);
        if (result.writer !== id) throw new Error("synthetic writer identity changed");
        return result;
      })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("synthetic 60-second profiler deadline")), 60_000); }),
    ]);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error("synthetic ledger custody unavailable");
    const raw = readFileSync(path, "utf8");
    if (!raw.endsWith("\n")) throw new Error("synthetic row is partial");
    const rows = raw.trimEnd().split("\n").map(line => JSON.parse(line));
    if (rows.length !== 960 || new Set(rows.map(row => `${row.hook}:${row.durationMs}`)).size !== 960) throw new Error("synthetic row inventory changed");
    const metrics: Metrics = {};
    for (const result of results) for (const [name, value] of Object.entries(result.metrics)) {
      const metric = metrics[name] ??= { calls: 0, errors: 0, ms: 0 }; metric.calls += value.calls; metric.errors += value.errors; metric.ms += value.ms;
    }
    for (const metric of Object.values(metrics)) metric.ms = Math.round(metric.ms);
    return { schema: "ashlr.ledger-synthetic-profile.v1", platform: process.platform,
      qualification: false, rows: 960, writers: 12, rowsPerWriter: 80, lockWaitMs: 500,
      elapsedMs: Math.round(performance.now() - started), contended: results.reduce((n, r) => n + r.contended, 0),
      appendMs: results.reduce((n, r) => n + r.appendMs, 0),
      retrySleepMs: results.reduce((n, r) => n + r.retrySleepMs, 0),
      writerElapsedMs: results.map(result => result.elapsedMs), rowsAt19Seconds, metrics };
  } finally {
    clearTimeout(timer); clearTimeout(progressTimer);
    for (const child of children) if (!settled.has(child) && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.race([Promise.allSettled(children.map(child => child.exited)), Bun.sleep(500)]);
    const current = lstatSync(root, { bigint: true });
    if (settled.size === children.length && current.isDirectory() && !current.isSymbolicLink() &&
        current.dev === identity.dev && current.ino === identity.ino && current.birthtimeNs === identity.birthtimeNs) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
if (import.meta.main) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--worker") await worker();
    else if (process.argv.length === 2 && process.platform === "win32") console.log("WINDOWS_LEDGER_SYNTHETIC_PROFILE " + JSON.stringify(await profileLedgerWrites()));
    else throw new Error("native Windows synthetic profiling context required");
  } catch { console.error("Synthetic ledger profile failed"); process.exitCode = 1; }
}
