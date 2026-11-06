#!/usr/bin/env bun
/** bun scripts/fleet-snapshot.ts [--since CURSOR]
 * Read-only ~/.ashlr/fleet snapshot. Collections contain upserts; removed contains
 * deleted ids. PRs are job-reported links, not live GitHub status. Missing sources
 * are null (unknown). Pass the opaque cursor back for net changes since that read.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fleetState, readFleetJobsText } from "../servers/fleet-state-server-handlers";
import { asRecord as record, defaultFleetRoot, fleetCli, jobLane } from "./lib/fleet-common.ts";
const canonical = (v: unknown): string => JSON.stringify(v, (_, value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
type Collection = Record<string, unknown> | null;
type Cursor = { version: number; scope: string; entries: Record<string, Record<string, string> | null>; leader: string; errors: string };

export function fleetSnapshot(since?: string, root = defaultFleetRoot()): { schema_version: number; cursor: string; removed: Record<string, string[]>; [key: string]: unknown } {
  const scope = hash(resolve(root));
  let previous: Cursor | undefined;
  if (since !== undefined) {
    try {
      if (since.length > 4 * 1024 * 1024) throw new Error();
      previous = JSON.parse(since);
      if (previous?.version !== 1 || previous.scope !== scope ||
        typeof previous.leader !== "string" || typeof previous.errors !== "string" ||
        !previous.entries || !["lanes", "jobs", "prs"].every(key => {
          const entry = previous!.entries[key];
          return entry === null || (entry && typeof entry === "object" && !Array.isArray(entry) &&
            Object.values(entry).every(value => typeof value === "string"));
        })) throw new Error();
    } catch { throw new Error("invalid snapshot cursor"); }
  }
  const state = fleetState(root);
  let jobs: Collection = null;
  if (!state.errors["jobs.jsonl"]) {
    // Read the full bounded log: fleetState's UI tail is intentionally only 20 rows.
    try {
      const rows = readFleetJobsText(root).split("\n").filter(line => line.trim()).map(line => {
        const job = record(JSON.parse(line));
        const id = job.job_id ?? job.id;
        if (typeof id !== "string" && typeof id !== "number") throw new Error();
        return [String(id), job] as const;
      });
      jobs = Object.fromEntries(rows); // Last record for each job wins.
    } catch (error) {
      state.errors["jobs.jsonl"] = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid";
    }
  }
  const targets = record(state.targets), holds = record(state.holds);
  const lanes: Collection = state.errors["targets.json"] || state.errors["holds.json"] ? null :
    Object.fromEntries([...new Set([...Object.keys(targets), ...Object.keys(holds),
      ...Object.values(jobs ?? {}).map(job => jobLane(record(job)))])]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map(id => [id, { target: targets[id] ?? null, hold: holds[id] ?? null }]));
  const prs: Collection = jobs === null ? null : Object.fromEntries(Object.entries(jobs)
    .filter(([, job]) => typeof record(job).pr_url === "string")
    .map(([id, job]) => [id, { job_id: id, url: record(job).pr_url }]));
  const entries: Cursor["entries"] = {};
  const changes: Record<string, unknown> = {};
  const removed: Record<string, string[]> = {};
  for (const [key, current] of Object.entries({ lanes, jobs, prs })) {
    const before = previous?.entries[key];
    entries[key] = current === null ? null : Object.fromEntries(Object.entries(current).map(([id, value]) => [id, hash(value)]));
    if (current === null) {
      if (!previous || before !== null) changes[key] = null;
      continue;
    }
    const updated = Object.fromEntries(Object.entries(current).filter(([id, value]) => before?.[id] !== hash(value)));
    if (!previous || before === null || Object.keys(updated).length) changes[key] = updated;
    const deleted = Object.keys(before ?? {}).filter(id => !Object.hasOwn(current, id));
    if (deleted.length) removed[key] = deleted;
  }
  const leader = hash(state.leader_event), errors = hash(state.errors);
  if (!previous || previous.leader !== leader) changes.leader = state.leader_event;
  if (!previous || previous.errors !== errors) changes.errors = state.errors;
  return { schema_version: 1, cursor: canonical({ version: 1, scope, entries, leader, errors }),
    ...changes, removed };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  void fleetCli(() => {
    if (args.length && (args.length !== 2 || args[0] !== "--since")) throw new Error();
    return fleetSnapshot(args[1]);
  }, "fleet-snapshot: invalid cursor or arguments; usage: bun scripts/fleet-snapshot.ts [--since CURSOR]");
}
