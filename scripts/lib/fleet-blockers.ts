#!/usr/bin/env bun
/** bun scripts/fleet-blockers.ts [RUNS_DIR]
 * Read-only JSON idle verdict over the ~/.ashlr-runs router queue (default
 * $HOME/.ashlr-runs; one optional root argument for fixtures). Per lane:
 * live workers (queue/run pid and command-line evidence) versus slots.json
 * targets, HOLD-file lane holds and *.phdrip held jobs, and ghost worktrees.
 * Restock is unfilled unheld demand — a lane's deficit (target - live) left
 * over after its READY and CLAIMED ROUTER-QUEUE.md rows — reported beside the
 * rows the router already picked (CLAIMED) and the ready supply (READY).
 * The AUTOAUTHOR signal is the age in seconds of the newest router event of
 * that type, stale past AUTOAUTHOR_STALE_S; the queue signal flags READY or
 * CLAIMED rows whose first 160 bytes split a UTF-8 character (truncated
 * lines). Rows count statuses and pool lanes only — queue text is never
 * echoed. Missing or unreadable sources are explicit errors, never invented
 * demand: verdict "unknown" when targets or live evidence are absent, "idle"
 * only on proven unmet demand, "held" when every deficit lane is held, else
 * "working". Blocker codes explain the verdict; nothing is mutated.
 */
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { fleetSource, readBoundedBuffer } from "../../servers/_fleet-source";
import { asRecord as record, defaultRunsRoot, fleetCli } from "./fleet-common.ts";
import { CRED_KEY, CRED_VALUE, fleetAuthor } from "../fleet-author";
import { redactSecrets } from "../../servers/_crash-dump";
import type { GhostDeps } from "../fleet-ghosts";

/** Seconds past which the newest AUTOAUTHOR beat marks the queue author stale. */
export const AUTOAUTHOR_STALE_S = 900;
const AUTHOR_FILES = ["router-events.log", "queue-author-codex.log", "ROUTER-QUEUE.md"] as const;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// Markdown queue rows: "- STATUS RQ-id (pool=lane, ...)". The queue.v1 JSONL
// shape counts its status field too. Only status and pool are read — job ids
// and row text never enter the report.
const ROW = /^\s*-\s+([A-Z][A-Z0-9-]{0,31})\s+\S/;
const POOL = /\bpool=([A-Za-z0-9][A-Za-z0-9._@-]{0,63})\b/;
const STATUS = /^[A-Z][A-Z0-9-]{0,31}$/;
const TIMESTAMP = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)/;
const NEEDS = "supervisor/NEEDS-MASON.md", INBOX = "leader/MASON-INBOX.md";

const failure = (error: unknown): string =>
  (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing"
    : error instanceof Error && ["unsafe", "too_large", "invalid"].includes(error.message) ? error.message : "unavailable";

export interface LaneBlockers {
  target: number | null;   // slots.json target; null when the lane has no slot row
  live: number;            // verified-live workers; a floor while live_known is false
  held: string | null;     // HOLD-file reason, "*" wildcard or slot flag; marks the lane held
  ghosts: number;          // abandoned .base worktrees in queue/run
  held_jobs: number;       // *.phdrip markers: jobs held out of dispatch
  ready: number;           // READY queue rows pooled to the lane
  picked: number;          // CLAIMED queue rows pooled to the lane
  deficit: number | null;  // max(0, target - live); null while live is unknown
  need: number | null;     // max(0, deficit - ready - picked)
}

export interface FleetBlockers {
  schema_version: 1;
  generatedAt: string;
  runs: string;
  verdict: "working" | "held" | "idle" | "unknown";
  /** true on a proven idle fleet, null when the evidence cannot say. */
  idle: boolean | null;
  blockers: string[];
  lanes: Record<string, LaneBlockers>;
  totals: { lanes: number; target: number | null; live: number; demand: number;
    held_demand: number; ghosts: number; held_jobs: number; ghost_jobs: string[]; held_job_ids: string[] };
  restock: { need: number | null; ready: number | null; picked: number | null;
    by_status: Record<string, number> | null };
  autoauthor: { age_s: number | null; threshold_s: number; stale: boolean; last_error: string | null };
  queue: { status: "ok" | "split_utf8" | "unknown"; rows: number;
    split_lines: { line: number; lines_from_tail: number }[] };
  live_known: boolean;
  human_needs: { asks: { ask: string; age_h: number | null; repeat_count: number | null }[]; inbox_age_h: number | null };
  sources: Record<string, string>;
  errors: Record<string, string>;
}

export function fleetBlockers(root = defaultRunsRoot(), deps: GhostDeps = {}): FleetBlockers {
  const resolved = resolve(root);
  const now = (deps.now ?? Date.now)();
  const state = fleetSource(resolved, deps);
  const errors: Record<string, string> = { ...state.errors };

  // Fixed author inputs — the same bounded, link-free reads as the queue state.
  const read = (name: string): Buffer | null => {
    try { return readBoundedBuffer(resolved, name); }
    catch (error) { errors[name] = failure(error); return null; }
  };
  const [events, codex, queue] = AUTHOR_FILES.map(read) as [Buffer | null, Buffer | null, Buffer | null];
  // Optional journals: absence is empty, but unsafe/unreadable evidence is an error.
  const journal = (name: string): string => {
    try { return utf8.decode(readBoundedBuffer(resolved, name)); }
    catch (error) {
      if (failure(error) !== "missing") errors[name] = error instanceof TypeError ? "invalid_utf8" : failure(error);
      return "";
    }
  };
  const age = (time: number) => Number.isFinite(time) && time <= now ? (now - time) / 3_600_000 : null;
  const asks = new Map<string, FleetBlockers["human_needs"]["asks"][number]>();
  // - [ ] [ISO timestamp] Ask (repeats=N). Checked rows are resolved.
  for (const line of journal(NEEDS).split("\n")) {
    const row = line.match(/^\s*-\s+\[ \]\s+(.+)$/);
    if (!row) continue;
    const stamp = row[1]!.match(TIMESTAMP)?.[0];
    const hours = age(Date.parse(stamp ?? ""));
    const count = Number(row[1]!.match(/\(repeats=([^)]*)\)\s*$/)?.[1] ?? 1);
    const ask = (stamp ? row[1]!.replace(stamp, "") : row[1]!).replace(/^\s*\[\s*\]\s*/, "")
      .replace(/\s*\(repeats=[^)]*\)\s*$/, "").trim();
    const validCount = Number.isSafeInteger(count) && count > 0;
    if (hours === null || !validCount || !ask) errors[NEEDS] = "invalid";
    if (!ask) continue;
    const previous = asks.get(ask);
    const repeats = !validCount || previous?.repeat_count === null ? NaN : (previous?.repeat_count ?? 0) + count;
    if (!Number.isSafeInteger(repeats)) errors[NEEDS] = "invalid";
    asks.set(ask, { ask, age_h: previous?.age_h === null || hours === null ? null : Math.max(previous?.age_h ?? 0, hours),
      repeat_count: Number.isSafeInteger(repeats) ? repeats : null });
  }
  let inboxAge: number | null = null;
  for (const line of journal(INBOX).split("\n")) {
    if (!/^\s*(?:#{1,6}\s|[-*]\s)/.test(line)) continue;
    const stamp = line.match(TIMESTAMP)?.[0];
    if (!stamp) continue;
    const hours = age(Date.parse(stamp));
    if (hours === null) errors[INBOX] = "invalid";
    else inboxAge = Math.min(inboxAge ?? Infinity, hours);
  }

  // fleetAuthor shares one parse for the beat age, the redacted last author
  // error and the truncated-UTF-8 scan; a malformed queue still yields the rest.
  let author: ReturnType<typeof fleetAuthor>;
  try {
    author = fleetAuthor(events?.toString("utf8") ?? "", codex?.toString("utf8") ?? "", queue ?? Buffer.alloc(0), now);
  } catch {
    errors["ROUTER-QUEUE.md"] = "invalid_utf8";
    author = fleetAuthor(events?.toString("utf8") ?? "", codex?.toString("utf8") ?? "", Buffer.alloc(0), now);
  }
  const queueStatus: FleetBlockers["queue"]["status"] =
    errors["ROUTER-QUEUE.md"] ? "unknown" : author.queue_status === "split_utf8" ? "split_utf8" : "ok";

  // Queue inventory: status counts plus per-lane READY/CLAIMED supply. Rows
  // without a pool lane count in by_status but cannot cover a lane's demand.
  const byStatus: Record<string, number> = {};
  const supply = { READY: new Map<string, number>(), CLAIMED: new Map<string, number>() };
  let rows = 0;
  if (queue !== null && errors["ROUTER-QUEUE.md"] === undefined) {
    // fleetAuthor decoded this buffer fatally already, so this cannot throw.
    for (const line of utf8.decode(queue).split("\n")) {
      let status: string | null = line.match(ROW)?.[1] ?? null;
      if (status === null && line.trimStart().startsWith("{")) {
        try {
          const s = record(JSON.parse(line)).status;
          if (typeof s === "string" && STATUS.test(s)) status = s;
        } catch { /* an unparseable row contributes nothing */ }
      }
      if (status === null) continue;
      rows++;
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      const pool = line.match(POOL)?.[1];
      if (pool !== undefined && (status === "READY" || status === "CLAIMED"))
        supply[status].set(pool, (supply[status].get(pool) ?? 0) + 1);
    }
  }

  const lanes = new Map<string, LaneBlockers>();
  const lane = (name: string): LaneBlockers => {
    let l = lanes.get(name);
    if (l === undefined) {
      l = { target: null, live: 0, held: null, ghosts: 0, held_jobs: 0, ready: 0, picked: 0, deficit: null, need: null };
      lanes.set(name, l);
    }
    return l;
  };
  const targets = state.targets === null ? null : record(state.targets);
  for (const [name, value] of Object.entries(targets ?? {})) {
    const l = lane(name);
    const target = typeof value === "number" ? value : record(value).target;
    l.target = typeof target === "number" && Number.isSafeInteger(target) && target >= 0 ? target : null;
    if (record(value).held === true) l.held = "held";
  }
  const holds = state.holds === null ? null : record(state.holds);
  const reason = (value: unknown) => (typeof value === "string" ? value.slice(0, 500) : "held");
  for (const [name, value] of Object.entries(holds ?? {})) if (name !== "*") lane(name).held = reason(value);
  const laneOf = (qualified: string) => qualified.includes("/") ? qualified.slice(0, qualified.indexOf("/")) : ".";
  for (const q of state.live.live) lane(laneOf(q)).live++;
  for (const q of state.live.ghosts) lane(laneOf(q)).ghosts++;
  for (const q of state.live.held) lane(laneOf(q)).held_jobs++;
  for (const [pool, n] of supply.READY) lane(pool).ready += n;
  for (const [pool, n] of supply.CLAIMED) lane(pool).picked += n;
  for (const l of lanes.values()) {
    if (l.held === null && holds?.["*"] !== undefined) l.held = reason(holds["*"]);
    if (l.target !== null && state.live.live_known) {
      l.deficit = Math.max(0, l.target - l.live);
      l.need = Math.max(0, l.deficit - l.ready - l.picked);
    }
  }

  const blockers: string[] = [];
  const names = [...lanes.keys()].sort((a, b) => a.localeCompare(b));
  let demand = 0, heldDemand = 0, unmet = 0, unmetered = false;
  const totals = { lanes: names.length, target: 0, live: 0, ghosts: 0, held_jobs: 0 };
  if (!state.live.live_known) blockers.push("live_unknown");
  for (const name of names) {
    const l = lanes.get(name)!;
    totals.live += l.live; totals.ghosts += l.ghosts; totals.held_jobs += l.held_jobs;
    if (l.ghosts) blockers.push(`ghosts:${name}`);
    if (l.held_jobs) blockers.push(`held_jobs:${name}`);
    if (l.target === null) continue;
    totals.target += l.target;
    if (l.deficit === null) { unmetered = true; continue; }
    if (l.deficit > 0) {
      // A deficit a lane's queued READY/CLAIMED rows already cover is en route,
      // not blocked; a held lane's whole deficit is explained by the hold.
      if (l.held === null) {
        demand += l.deficit; unmet += l.need ?? 0;
        if ((l.need ?? 0) > 0) blockers.push(`shortfall:${name}`);
      } else { heldDemand += l.deficit; blockers.push(`held_lane:${name}`); }
    }
  }
  const queueOk = queue !== null && errors["ROUTER-QUEUE.md"] === undefined;
  if (unmet > 0) {
    // Unmet unheld demand: name the pipeline stage that is failing it.
    if (!queueOk) blockers.push("queue_unreadable");
    else if ((byStatus.READY ?? 0) + (byStatus.CLAIMED ?? 0) === 0) blockers.push("queue_empty");
    else blockers.push("queue_short");
    const age = author.last_autoauthor_age_s;
    if (age === null) blockers.push(errors["router-events.log"] ? "autoauthor_unknown" : "autoauthor_silent");
    else if (age > AUTOAUTHOR_STALE_S) blockers.push("autoauthor_stale");
  }
  if (author.split_lines.length) blockers.push("queue_split_utf8");
  if (Object.keys(errors).length) blockers.push("sources_degraded");

  const verdict: FleetBlockers["verdict"] =
    targets === null ? "unknown" :                       // no demand evidence at all
    unmet > 0 ? "idle" :                                 // proven unmet by metered lanes
    unmetered ? "unknown" :                              // a target lane's live is unknowable
    demand === 0 ? (heldDemand > 0 ? "held" : "working") :
    "working";                                           // deficits already covered by supply

  const source = (name: string, key: string, dir = false): string => {
    if (errors[key] !== undefined) return errors[key];
    try {
      const stat = lstatSync(join(resolved, name));
      return !dir || stat.isDirectory() ? "ok" : "absent";
    } catch { return "absent"; }
  };
  return {
    schema_version: 1,
    generatedAt: new Date(now).toISOString(),
    runs: resolved,
    verdict,
    idle: verdict === "idle" ? true : verdict === "unknown" ? null : false,
    blockers,
    lanes: Object.fromEntries(names.map(name => [name, lanes.get(name)!])),
    totals: { ...totals, target: targets === null ? null : totals.target, demand, held_demand: heldDemand,
      ghost_jobs: state.live.ghosts, held_job_ids: state.live.held },
    restock: {
      need: targets === null || !state.live.live_known ? null : unmet,
      ready: queueOk ? byStatus.READY ?? 0 : null,
      picked: queueOk ? byStatus.CLAIMED ?? 0 : null,
      by_status: queueOk ? byStatus : null,
    },
    autoauthor: {
      age_s: author.last_autoauthor_age_s,
      threshold_s: AUTOAUTHOR_STALE_S,
      stale: author.last_autoauthor_age_s !== null && author.last_autoauthor_age_s > AUTOAUTHOR_STALE_S,
      last_error: author.last_codex_error,
    },
    queue: { status: queueStatus, rows, split_lines: author.split_lines },
    live_known: state.live.live_known,
    human_needs: { asks: [...asks.values()].map(ask => ({ ...ask,
      ask: redactSecrets(ask.ask).replace(CRED_VALUE, (match, key: string, separator: string) =>
        CRED_KEY.test(key.replace(/["']$/, "")) ? key + separator + "[REDACTED]" : match)
        .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[REDACTED]")
        .replace(/[A-Za-z0-9_+\/-]{32,}={0,2}/g, "[REDACTED]").slice(0, 1000) })), inbox_age_h: inboxAge },
    sources: {
      "queue/slots.json": source("queue/slots.json", "targets.json"),
      "HOLD": source("HOLD", "holds.json"),
      "metrics/jobs.jsonl": source("metrics/jobs.jsonl", "jobs.jsonl"),
      "queue/dispatch-events.log": source("queue/dispatch-events.log", "leader-events.jsonl"),
      "queue/run": source("queue/run", "live.json", true),
      "router-events.log": source("router-events.log", "router-events.log"),
      "queue-author-codex.log": source("queue-author-codex.log", "queue-author-codex.log"),
      "ROUTER-QUEUE.md": source("ROUTER-QUEUE.md", "ROUTER-QUEUE.md"),
      [NEEDS]: source(NEEDS, NEEDS),
      [INBOX]: source(INBOX, INBOX),
    },
    errors,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  void fleetCli(() => {
    if (args.length > 1 || args[0]?.startsWith("-")) throw new Error();
    return fleetBlockers(args[0] ?? defaultRunsRoot());
  }, "fleet-blockers: usage: bun scripts/fleet-blockers.ts [RUNS_DIR]").then(report => {
    if (report && Object.keys(report.errors).length) process.exitCode = 1;
  });
}
