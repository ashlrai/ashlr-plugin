#!/usr/bin/env bun
/**
 * bun scripts/fleet-steer.ts lanes|proposals [--root DIR]
 * bun scripts/fleet-steer.ts propose --action reassign --job-id JOB --lane LANE --author NAME --reason TEXT [--root DIR]
 * bun scripts/fleet-steer.ts propose --action set-slots --lane LANE --slots N --author NAME --reason TEXT [--root DIR]
 * Every command emits JSON. Proposals append audited records to steer-proposals.jsonl
 * under the fleet root only — slots.json and every fleet state file stay unwritable.
 * Proposals are suggestions for controller review, never applied changes; an
 * identical pending proposal is refused.
 */
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { appendFleetRecord } from "../servers/fleet-intent-server-handlers";
import { fleetState, readFleetJobsText } from "../servers/fleet-state-server-handlers";

const PROPOSALS = "steer-proposals.jsonl";
const PROTECTED = `Proposals may only append to ${PROPOSALS}; slots.json and fleet state files are protected`;
const usage = "Usage: fleet-steer lanes|proposals|propose [--root DIR] [--output " + PROPOSALS + "]" +
  " --action reassign --job-id JOB --lane LANE | --action set-slots --lane LANE --slots N" +
  " --author NAME --reason TEXT";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_BYTES = 4 * 1024 * 1024;
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
// Action -> required subject fields; the flags map keeps CLI names aligned.
const subjects: Record<string, string[]> = { reassign: ["job_id", "lane"], "set-slots": ["lane", "slots"] };
const flags: Record<string, string> = { job_id: "--job-id", lane: "--lane", slots: "--slots" };

/** Bounded, link-resistant read of the fixed proposal journal. */
function readProposals(output: string): { proposals: Record<string, unknown>[]; skipped: number } {
  let stat;
  try { stat = lstatSync(output); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { proposals: [], skipped: 0 };
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe proposal journal");
  const fd = openSync(output, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const now = fstatSync(fd);
    if (!now.isFile() || now.nlink !== 1 || now.ino !== stat.ino || now.dev !== stat.dev) throw new Error("unsafe proposal journal");
    if (now.size > MAX_BYTES) throw new Error("proposal journal too large");
    const buffer = Buffer.alloc(now.size);
    let length = 0, count: number;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    const proposals: Record<string, unknown>[] = [];
    let skipped = 0;
    for (const line of buffer.toString("utf8", 0, length).split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) proposals.push(parsed as Record<string, unknown>);
        else skipped++;
      } catch { skipped++; }
    }
    return { proposals, skipped };
  } finally { closeSync(fd); }
}

/** Lanes view: targets and holds plus per-lane job counts from the full job log. */
function lanes(root: string) {
  const state = fleetState(root);
  const targets = record(state.targets), holds = record(state.holds);
  let jobs: Record<string, number> | null = null;
  if (!state.errors["jobs.jsonl"]) {
    try {
      const byId = new Map<string, string>();
      for (const line of readFleetJobsText(root).split("\n")) {
        if (!line.trim()) continue;
        const job = record(JSON.parse(line));
        const id = job.job_id ?? job.id;
        if (id === undefined) continue;
        byId.set(String(id), String(record(job).pool ?? record(job).lane ?? "unassigned"));
      }
      jobs = {};
      for (const lane of byId.values()) jobs[lane] = (jobs[lane] ?? 0) + 1;
    } catch (error) {
      state.errors["jobs.jsonl"] = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid";
      jobs = null;
    }
  }
  const merged = Object.fromEntries([...new Set([...Object.keys(targets), ...Object.keys(holds), ...Object.keys(jobs ?? {})])]
    .sort((a, b) => a.localeCompare(b))
    .map(id => [id, { target: targets[id] ?? null, hold: holds[id] ?? null, jobs: jobs === null ? null : jobs[id] ?? 0 }]));
  return { lanes: merged, errors: state.errors };
}

/** Only terminal statuses release the dedup key; anything else still awaits review. */
const TERMINAL = new Set(["applied", "rejected", "withdrawn", "superseded"]);
const pendingKey = (p: Record<string, unknown>) =>
  typeof p.status === "string" && TERMINAL.has(p.status) ? null
    : JSON.stringify({ action: p.action, job_id: p.job_id ?? null, lane: p.lane ?? null, slots: p.slots ?? null });

export function fleetSteer(argv: string[], now = new Date(), root = join(homedir(), ".ashlr", "fleet")) {
  const [command, ...args] = argv;
  if (command !== "lanes" && command !== "proposals" && command !== "propose") throw new Error(usage);
  const allowed = command === "lanes" ? ["--root"] :
    command === "proposals" ? ["--root", "--output"] :
    ["--root", "--output", "--action", "--job-id", "--lane", "--slots", "--author", "--reason"];
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!allowed.includes(key!) || value === undefined || !value.trim() || options.has(key!)) throw new Error(usage);
    options.set(key!, value);
  }
  const fleetRoot = resolve(options.get("--root") ?? root);
  const output = resolve(fleetRoot, options.get("--output") ?? PROPOSALS);
  // Only this fixed journal is writable, including when callers supply a path.
  if (basename(output).toUpperCase() !== PROPOSALS.toUpperCase() || output !== resolve(fleetRoot, PROPOSALS)) {
    throw new Error(PROTECTED);
  }
  if (command === "lanes") return { command: "lanes" as const, root: fleetRoot, ...lanes(fleetRoot) };
  const journal = readProposals(output);
  if (command === "proposals") return { command: "proposals" as const, output, ...journal };

  const action = options.get("--action"), author = options.get("--author")?.trim(), reason = options.get("--reason")?.trim();
  if (action !== "reassign" && action !== "set-slots" || !author || author.length > 200 ||
      /[\r\n\x00-\x1f\x7f]/.test(author) || !reason || reason.length > 512) throw new Error(usage);
  if (Object.keys(flags).some(field => options.has(flags[field]!) !== subjects[action]!.includes(field))) throw new Error(usage);
  const subject: Record<string, unknown> = { action };
  for (const field of subjects[action]!) {
    const value = options.get(flags[field]!)!;
    if (field === "slots" ? !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 1024
        : !IDENTIFIER.test(value)) throw new Error(`invalid fleet steer ${field}`);
    subject[field] = field === "slots" ? Number(value) : value;
  }
  if (journal.proposals.some(p => pendingKey(p) === pendingKey({ status: "proposed", ...subject }))) {
    throw new Error("duplicate proposal");
  }
  const laneNow = record(record(lanes(fleetRoot).lanes)[String(subject.lane)]);
  const observed: { target: unknown; hold: unknown; job_lane?: string | null } =
    { target: laneNow.target ?? null, hold: laneNow.hold ?? null };
  if (action === "reassign") {
    observed.job_lane = null;
    try {
      // Latest upsert wins, mirroring the snapshot reader's last-record rule.
      for (const line of readFleetJobsText(fleetRoot).split("\n")) {
        if (!line.trim()) continue;
        const job = record(JSON.parse(line));
        const id = job.job_id ?? job.id;
        if (id !== undefined && String(id) === subject.job_id) {
          observed.job_lane = String(record(job).pool ?? record(job).lane ?? "unassigned");
        }
      }
    } catch { /* observed stays null when the job log is unreadable */ }
  }
  const proposal = {
    schema_version: 1, id: randomUUID(), proposed_at: now.toISOString(), author, ...subject,
    observed, reason, status: "proposed",
  };
  appendFleetRecord(fleetRoot, PROPOSALS, proposal);
  return { command: "propose" as const, output, proposal, bytesAppended: Buffer.byteLength(JSON.stringify(proposal) + "\n") };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(fleetSteer(process.argv.slice(2))));
  } catch {
    console.error(JSON.stringify({ error: `Steer command failed: check arguments and file paths. Only ${PROPOSALS} is writable.`, usage }));
    process.exitCode = 1;
  }
}
