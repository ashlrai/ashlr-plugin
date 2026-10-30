#!/usr/bin/env bun
/** bun scripts/fleet-resources.ts [--hours N]
 * Shared resource ledger over Phantom's own data: runs `ashlr resources --json`
 * (the ResourceMonitor snapshot), joins ~/.ashlr-runs/queue/slots.json lane
 * targets with ~/.ashlr-runs/metrics/jobs.jsonl job events, then atomically
 * rewrites ~/.ashlr-runs/resources.json and prints the same JSON to stdout.
 * Per lane: availability, cap headroom (`left` in capUnit), reset time, slot
 * target/running, jobs and tokens per hour, and a naive projected exhaustion
 * at the current burn rate. Every field is null ("unknown") when its source
 * is absent. The trailing window defaults to 6 hours (fleet-latency's span).
 * jobs.jsonl `tokens` is cumulative per job: a job's first reading counts in
 * full at its timestamp, later readings count their positive delta.
 */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const MAX_BYTES = 4 * 1024 * 1024;
const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}$/;
const CAP_UNITS = new Set(["messages", "tokens", "requests", "concurrent"]);
/** Lane-state vocabulary: last recognized transition in file order wins. */
const LIVE = new Set(["launch", "launched", "dispatch", "dispatched", "start", "started", "running",
  "stalled", "claimed", "pr-open", "in-progress", "working", "publishing", "publish_unknown", "resumed"]);
const SETTLED = new Set(["finish", "finished", "done", "publish", "published", "outcome",
  "precheck_skip", "precheck-skip", "merged", "merge", "landed", "land", "failed", "cancelled",
  "canceled", "killed", "deleted", "empty", "new", "queued", "queue", "ready", "retried", "retry",
  "updated", "waiting", "proposed", "held", "hold", "blocked", "unassigned", "scheduled"]);

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const pick = (row: Record<string, unknown>, ...keys: string[]) =>
  keys.map(key => row[key]).find((v): v is string => typeof v === "string" && v.trim().length > 0)?.trim();
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
const int = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const iso = (ms: number | null) => {
  if (ms === null || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export interface LaneLedger {
  availability: string | null;
  usedPct: number | null;
  cap: number | null;
  capUnit: string | null;
  capWindow: string | null;
  left: number | null;
  resetsAt: string | null;
  backoffUntil: string | null;
  costPerMTokenOut: number | null;
  p50LatencyMs: number | null;
  reason: string | null;
  slotsTarget: number | null;
  slotsRunning: number | null;
  slotsLeft: number | null;
  held: boolean | null;
  jobsPerHour: number | null;
  tokensPerHour: number | null;
  projectedExhaustionAt: string | null;
}
export interface FleetResources {
  schemaVersion: 1;
  generatedAt: string;
  windowHours: number;
  sources: { monitor: string; slots: string; jobs: string };
  lanes: Record<string, LaneLedger>;
}

interface JobRow { job: string | null; lane: string | null; ts: number | null; transition: string | null; tokens: number | null }

function parseJobs(text: string): JobRow[] {
  const rows: JobRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = record(JSON.parse(trimmed));
      const job = pick(row, "job", "job_id", "jobId", "id");
      const laneRaw = pick(row, "pool", "lane", "account");
      const tsRaw = pick(row, "timestamp", "ts", "time", "at", "landedAt", "mergedAt", "completedAt", "recordedAt", "updatedAt", "startedAt");
      const ts = tsRaw === undefined ? null : Date.parse(tsRaw);
      const transition = pick(row, "to", "event", "type", "transition", "verb", "action", "next", "newStatus", "status", "state", "outcome");
      const tokens = num(row.tokens ?? row.totalTokens ?? row.tokensUsed);
      rows.push({
        job: job !== undefined && JOB_ID.test(job) ? job : null,
        lane: laneRaw !== undefined && LANE_ID.test(laneRaw) ? laneRaw : null,
        ts: ts !== null && Number.isFinite(ts) ? ts : null,
        transition: transition?.toLowerCase() ?? null,
        tokens: tokens !== null && tokens >= 0 ? tokens : null,
      });
    } catch { /* A malformed line must not hide subsequent valid events. */ }
  }
  return rows;
}

/** Burn rates and live counts. The window is inclusive at both ends. */
function jobMetrics(rows: JobRow[], hours: number, now: number) {
  const windowMs = hours * 3_600_000;
  const laneOf = new Map<string, string>();              // job -> latest known lane
  const stateOf = new Map<string, "live" | "settled">(); // job -> slot occupancy
  const readings = new Map<string, { ts: number; tokens: number }[]>();
  for (const row of rows) {
    if (row.job === null) continue;
    if (row.lane !== null) laneOf.set(row.job, row.lane);
    if (row.transition !== null) {
      if (LIVE.has(row.transition)) stateOf.set(row.job, "live");
      else if (SETTLED.has(row.transition)) stateOf.set(row.job, "settled");
    }
    if (row.ts !== null && row.tokens !== null) {
      const list = readings.get(row.job) ?? [];
      list.push({ ts: row.ts, tokens: row.tokens });
      readings.set(row.job, list);
    }
  }
  const running = new Map<string, number>(), jobsPerHour = new Map<string, number>(),
    tokensPerHour = new Map<string, number>(), active = new Map<string, Set<string>>(),
    tokensEarned = new Map<string, number>();
  for (const [job, state] of stateOf) {
    const lane = laneOf.get(job);
    if (state === "live" && lane !== undefined) running.set(lane, (running.get(lane) ?? 0) + 1);
  }
  // Lanes resolve through laneOf, so rows without their own pool still attribute.
  for (const row of rows) {
    if (row.job === null || row.ts === null || row.ts < now - windowMs || row.ts > now) continue;
    const lane = row.lane ?? laneOf.get(row.job);
    if (lane === undefined) continue;
    const set = active.get(lane) ?? new Set<string>();
    set.add(row.job);
    active.set(lane, set);
  }
  for (const [lane, jobs] of active) jobsPerHour.set(lane, round3(jobs.size / hours));
  for (const [job, list] of readings) {
    const lane = laneOf.get(job);
    if (lane === undefined) continue;
    let previous: number | null = null;
    for (const { ts, tokens } of list) {
      const earned = previous === null ? tokens : Math.max(0, tokens - previous);
      previous = tokens;
      if (earned > 0 && ts >= now - windowMs && ts <= now) {
        tokensEarned.set(lane, (tokensEarned.get(lane) ?? 0) + earned);
      }
    }
  }
  for (const [lane, tokens] of tokensEarned) tokensPerHour.set(lane, round3(tokens / hours));
  return { running, jobsPerHour, tokensPerHour };
}

/** Join the ResourceMonitor snapshot with queue slots and job metrics. */
export function fleetResources(
  source: { monitor: string | null; slots: string | null; jobs: string | null },
  hours = 6, now = Date.now(),
): FleetResources {
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(hours * 3_600_000) ||
      !Number.isFinite(now) || Math.abs(now) > 8.64e15) throw new Error("Invalid time window");
  const sources = { monitor: "missing", slots: "missing", jobs: "missing" };
  const lanes = new Map<string, Partial<LaneLedger>>();
  const lane = (name: string) => {
    const existing = lanes.get(name) ?? {};
    lanes.set(name, existing);
    return existing;
  };

  if (source.monitor !== null) {
    try {
      const snapshot = record(JSON.parse(source.monitor));
      if (!Array.isArray(snapshot.backends)) throw new Error();
      for (const entry of snapshot.backends) {
        const b = record(entry);
        const name = typeof b.backend === "string" && LANE_ID.test(b.backend) ? b.backend : null;
        if (name === null) continue;
        const usedPct = num(b.usedPct), cap = num(b.cap), resetsAtSec = num(b.resetsAt);
        const capUnit = typeof b.capUnit === "string" && CAP_UNITS.has(b.capUnit) ? b.capUnit : null;
        Object.assign(lane(name), {
          availability: typeof b.availability === "string" ? b.availability.slice(0, 32) : null,
          usedPct: usedPct !== null && usedPct >= 0 ? usedPct : null,
          cap: cap !== null && cap >= 0 ? cap : null,
          capUnit, capWindow: typeof b.capWindow === "string" ? b.capWindow.slice(0, 32) : null,
          left: cap !== null && cap >= 0 && usedPct !== null && usedPct >= 0
            ? round3(Math.max(0, cap * (100 - Math.min(usedPct, 100)) / 100)) : null,
          resetsAt: iso(resetsAtSec !== null && resetsAtSec > 0 ? resetsAtSec * 1000 : null),
          backoffUntil: iso(num(b.backoffUntilMs)),
          costPerMTokenOut: num(b.costPerMTokenOut),
          p50LatencyMs: num(b.p50LatencyMs),
          reason: typeof b.reason === "string" ? b.reason.slice(0, 300) : null,
        });
      }
      sources.monitor = "ok";
    } catch { sources.monitor = "invalid"; }
  }

  if (source.slots !== null) {
    try {
      const parsed: unknown = JSON.parse(source.slots);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      const slots = parsed as Record<string, unknown>;
      for (const [name, value] of Object.entries(slots)) {
        if (!LANE_ID.test(name)) continue;
        const slot = record(value);
        Object.assign(lane(name), {
          slotsTarget: int(slot.target), held: typeof slot.held === "boolean" ? slot.held : null });
      }
      sources.slots = "ok";
    } catch { sources.slots = "invalid"; }
  }

  if (source.jobs !== null) {
    try {
      const metrics = jobMetrics(parseJobs(source.jobs), hours, now);
      for (const name of new Set([...metrics.running.keys(), ...metrics.jobsPerHour.keys(), ...metrics.tokensPerHour.keys()])) lane(name);
      for (const [name, entry] of lanes) {
        entry.slotsRunning = metrics.running.get(name) ?? 0;
        entry.jobsPerHour = metrics.jobsPerHour.get(name) ?? 0;
        entry.tokensPerHour = metrics.tokensPerHour.get(name) ?? 0;
      }
      sources.jobs = "ok";
    } catch { sources.jobs = "invalid"; }
  }

  for (const entry of lanes.values()) {
    const target = entry.slotsTarget, running = entry.slotsRunning;
    entry.slotsLeft = typeof target === "number" && typeof running === "number"
      ? Math.max(0, target - running) : null;
    const rate = entry.capUnit === "tokens" ? entry.tokensPerHour :
      entry.capUnit === "messages" || entry.capUnit === "requests" ? entry.jobsPerHour : null;
    entry.projectedExhaustionAt = typeof entry.left !== "number" ? null :
      entry.left <= 0 ? new Date(now).toISOString() :
      rate ? iso(now + (entry.left / rate) * 3_600_000) : null;
  }

  const empty: LaneLedger = { availability: null, usedPct: null, cap: null, capUnit: null, capWindow: null,
    left: null, resetsAt: null, backoffUntil: null, costPerMTokenOut: null, p50LatencyMs: null, reason: null,
    slotsTarget: null, slotsRunning: null, slotsLeft: null, held: null,
    jobsPerHour: null, tokensPerHour: null, projectedExhaustionAt: null };
  return { schemaVersion: 1, generatedAt: new Date(now).toISOString(), windowHours: hours, sources,
    lanes: Object.fromEntries([...lanes].sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => [name, { ...empty, ...entry }])) };
}

/** Bounded read of a fixed runs-relative file; never follows links. */
function readRuns(root: string, name: string): string {
  const path = join(root, name);
  if (!lstatSync(root).isDirectory() || !lstatSync(dirname(path)).isDirectory()) throw new Error("unsafe");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error("unsafe");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0, count: number;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    if (length > MAX_BYTES) throw new Error("unsafe");
    return buffer.toString("utf8", 0, length);
  } finally { closeSync(fd); }
}

/** Fixed command contract: only `ashlr resources --json`, bounded and timed. */
function monitorText(): string {
  const result = spawnSync("ashlr", ["resources", "--json"], {
    encoding: "utf8", timeout: 30_000, maxBuffer: MAX_BYTES, stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string" || !result.stdout.trim()) throw new Error("unavailable");
  return result.stdout;
}

let tmpSeq = 0;
/** Same-directory tmp + rename; readers never see a partial ledger. */
export function writeAtomic(dir: string, name: string, text: string): void {
  if (!lstatSync(dir).isDirectory()) throw new Error("unsafe");
  const tmp = join(dir, `.${name}.${process.pid}.${Date.now().toString(36)}.${tmpSeq++}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, join(dir, name));
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch { /* already renamed or never created */ }
  }
}

export const RESOURCES_FILE = "resources.json";
/** A cached ledger stays authoritative this long; absent, unsafe, corrupt or older rebuilds. */
export const RESOURCES_TTL_MS = 60_000;

/** A cached ledger must parse to a ledger-shaped record generated within the TTL window. */
function freshLedger(text: string, now: number): FleetResources | null {
  try {
    const value: unknown = JSON.parse(text);
    const ledger = record(value);
    const generated = Date.parse(typeof ledger.generatedAt === "string" ? ledger.generatedAt : "");
    if (!Number.isFinite(generated) || Math.abs(now - generated) > RESOURCES_TTL_MS ||
        !ledger.lanes || typeof ledger.lanes !== "object" || Array.isArray(ledger.lanes)) return null;
    return value as FleetResources;
  } catch { return null; }
}

export function collectFleetResources(
  runs = join(homedir(), ".ashlr-runs"), hours = 6, now = Date.now(), monitor: () => string = monitorText,
) {
  const read = (name: string) => {
    try { return { text: readRuns(runs, name), unavailable: false }; }
    catch (error) { return { text: null, unavailable: (error as NodeJS.ErrnoException).code !== "ENOENT" }; }
  };
  const slots = read("queue/slots.json"), jobs = read("metrics/jobs.jsonl");
  let snapshot: string | null = null;
  try { snapshot = monitor(); } catch { /* absence degrades to unknown lanes */ }
  const ledger = fleetResources({ monitor: snapshot, slots: slots.text, jobs: jobs.text }, hours, now);
  if (snapshot === null) ledger.sources.monitor = "unavailable";
  if (slots.unavailable) ledger.sources.slots = "unavailable";
  if (jobs.unavailable) ledger.sources.jobs = "unavailable";
  return ledger;
}

/** Serve resources.json while it is fresh; rebuild the ledger otherwise. */
export function ensureFleetResources(
  runs = join(homedir(), ".ashlr-runs"), hours = 6, now = Date.now(), monitor: () => string = monitorText,
): { ledger: FleetResources; refreshed: boolean } {
  try {
    // Freshness is both clocks: the file mtime and the ledger's own generatedAt.
    const stat = lstatSync(join(runs, RESOURCES_FILE));
    if (stat.isFile() && Math.abs(now - stat.mtimeMs) <= RESOURCES_TTL_MS) {
      const cached = freshLedger(readRuns(runs, RESOURCES_FILE), now);
      if (cached !== null) return { ledger: cached, refreshed: false };
    }
  } catch { /* Missing, unsafe or corrupt cache falls through to a rebuild. */ }
  const ledger = collectFleetResources(runs, hours, now, monitor);
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  writeAtomic(runs, RESOURCES_FILE, JSON.stringify(ledger) + "\n");
  return { ledger, refreshed: true };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), options: {
      hours: { type: "string", default: "6" },
    }, strict: true, allowPositionals: false });
    const hours = Number(values.hours);
    if (!Number.isFinite(hours) || hours <= 0) throw new Error();
    const runs = join(homedir(), ".ashlr-runs");
    const ledger = collectFleetResources(runs, hours);
    const text = JSON.stringify(ledger);
    console.log(text);
    mkdirSync(runs, { recursive: true, mode: 0o700 });
    writeAtomic(runs, "resources.json", text + "\n");
  } catch {
    console.error("fleet-resources: check `ashlr resources --json` and ~/.ashlr-runs. Usage: bun scripts/fleet-resources.ts [--hours N]");
    process.exitCode = 1;
  }
}
