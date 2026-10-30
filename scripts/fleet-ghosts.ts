#!/usr/bin/env bun
/** bun scripts/fleet-ghosts.ts RUNS_DIR
 * Read-only JSON report, per lane, of reported-running jobs versus live ones.
 * Each immediate subdirectory of RUNS_DIR is a lane; job files directly under
 * RUNS_DIR belong to the "." lane. Inside a lane, <job>.log marks a reported
 * running job, <job>.log.gz its archived log and <job>.base/ its worktree. A
 * job is live when a <job>.pid names a running pid or a process command line
 * references its <lane>/<job>.base worktree. A worktree left behind — <job>.base
 * present, no <job>.log, a <job>.log.gz and no live process — is a ghost. The
 * process table and pid reads only set booleans; unreadable sources degrade to
 * explicit fields, never to mutations.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SUFFIXES = [".base", ".log.gz", ".pid", ".log"] as const;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isDir = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
// Tiny bound: a pid file is a few digits; refuse links and oversized content.
const readPid = (path: string): number | null => {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 64) return null;
    const text = readFileSync(path, "utf8").trim();
    return /^[1-9]\d{0,9}$/.test(text) ? Number(text) : null;
  } catch { return null; }
};
const PROC_LISTERS: [string, string[]][] = process.platform === "win32"
  ? [["powershell.exe", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine"]]]
  : [["ps", ["-axo", "args="]], ["pgrep", ["-fl", "."]]];
const psArgs = (): string[] => {
  for (const [cmd, args] of PROC_LISTERS) {
    try { return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n"); }
    catch { /* next lister */ }
  }
  throw new Error("no process lister");
};
const pidAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

interface Job { base: boolean; log: boolean; gz: boolean; pid: number | null }
export interface GhostLane {
  lane: string; reported: number; live: number; live_unknown: number;
  stalled: string[];   // .log present but no live process found
  ghosts: string[];    // .base worktree, no .log, .log.gz archived, no live process
}
export interface GhostReport {
  schema_version: 1; generatedAt: string; runs: string; live_known: boolean;
  lanes: GhostLane[]; errors: Record<string, string>;
  counts: { lanes: number; reported: number; live: number; live_unknown: number; stalled: number; ghosts: number };
}
export interface GhostDeps { procs?: () => string[]; alive?: (pid: number) => boolean; now?: () => number }

/** Fold one directory entry into the lane's job map. Returns whether it named a job. */
const note = (jobs: Map<string, Job>, dir: string, name: string): boolean => {
  const suffix = SUFFIXES.find(s => name.endsWith(s));
  if (!suffix) return false;
  const stem = name.slice(0, -suffix.length);
  if (!stem) return true;
  const job = jobs.get(stem) ?? { base: false, log: false, gz: false, pid: null };
  jobs.set(stem, job);
  if (suffix === ".base") job.base = isDir(join(dir, name));
  else if (suffix === ".log.gz") job.gz = true;
  else if (suffix === ".pid") job.pid = readPid(join(dir, name));
  else job.log = true;
  return true;
};

export function fleetGhosts(runsDir: string, deps: GhostDeps = {}): GhostReport {
  const root = resolve(runsDir);
  const alive = deps.alive ?? pidAlive;
  const errors: Record<string, string> = {};
  let procs: string[] | null = null;
  try { procs = (deps.procs ?? psArgs)(); } catch { errors["processes"] = "unavailable"; }
  // Live when a pid file names a live pid, or a command line mentions the worktree.
  const liveOf = (lane: string, name: string, job: Job): boolean | "unknown" => {
    if (job.pid !== null && alive(job.pid)) return true;
    if (procs === null) return "unknown";
    const tail = lane === "." ? `${name}.base` : `${lane}/${name}.base`;
    const pattern = new RegExp(`(^|[^\\w.\\-])${esc(tail)}(?![\\w\\-])`);
    return procs.some(line => pattern.test(line));
  };
  const laneReport = (lane: string, jobs: Map<string, Job>): GhostLane => {
    const out: GhostLane = { lane, reported: 0, live: 0, live_unknown: 0, stalled: [], ghosts: [] };
    for (const [name, job] of [...jobs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (job.log) {
        out.reported++;
        const live = liveOf(lane, name, job);
        if (live === true) out.live++;
        else if (live === "unknown") out.live_unknown++;
        else out.stalled.push(name);
      } else if (job.base && job.gz && liveOf(lane, name, job) === false) {
        out.ghosts.push(name);
      }
    }
    return out;
  };
  const lanes = new Map<string, string>(), rootJobs = new Map<string, Job>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!note(rootJobs, root, entry.name) && isDir(join(root, entry.name))) lanes.set(entry.name, join(root, entry.name));
  }
  const reports: GhostLane[] = [];
  for (const lane of [...lanes.keys()].sort((a, b) => a.localeCompare(b))) {
    try {
      const jobs = new Map<string, Job>();
      for (const entry of readdirSync(lanes.get(lane)!, { withFileTypes: true })) note(jobs, lanes.get(lane)!, entry.name);
      reports.push(laneReport(lane, jobs));
    } catch (error) { errors[lane] = (error as NodeJS.ErrnoException).code ?? "unavailable"; }
  }
  if (rootJobs.size) reports.push(laneReport(".", rootJobs));
  reports.sort((a, b) => a.lane.localeCompare(b.lane));
  return {
    schema_version: 1,
    generatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    runs: root,
    live_known: procs !== null,
    lanes: reports,
    errors,
    counts: {
      lanes: reports.length,
      reported: reports.reduce((n, r) => n + r.reported, 0),
      live: reports.reduce((n, r) => n + r.live, 0),
      live_unknown: reports.reduce((n, r) => n + r.live_unknown, 0),
      stalled: reports.reduce((n, r) => n + r.stalled.length, 0),
      ghosts: reports.reduce((n, r) => n + r.ghosts.length, 0),
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 1) throw new Error();
    console.log(JSON.stringify(fleetGhosts(args[0]!)));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(code ? `fleet-ghosts: ${args[0]}: ${code}` : "fleet-ghosts: usage: bun scripts/fleet-ghosts.ts RUNS_DIR");
    process.exitCode = 1;
  }
}
