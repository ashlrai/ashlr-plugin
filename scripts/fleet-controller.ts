#!/usr/bin/env bun
/**
 * bun scripts/fleet-controller.ts [--root DIR]
 *
 * The fleet controller's plan pass. Reads the two request journals under the
 * fleet root — actions.jsonl (fleet-act records with status "pending") and
 * steer-proposals.jsonl (fleet-steer / fleet-spawn proposals not yet in a
 * terminal state) — and prints one JSON plan: every pending request in
 * journal order with either its intended effect or the reason it is refused.
 *
 * Plan only: nothing is applied, no fleet file is changed, created or
 * removed, and there is no apply flag yet. Journals are opened read-only
 * with the same link-resistant reader the steering tools use; an unreadable
 * journal is reported in its own error slot instead of failing the plan.
 */
import { join, resolve } from "node:path";
import { readJournal, TERMINAL_STATUSES, type JournalRead } from "./fleet-journal";
import { defaultFleetRoot, fleetCli, parseFlagPairs } from "./lib/fleet-common.ts";

const usage = "Usage: fleet-controller [--root DIR]";
const ACTIONS = "actions.jsonl";
const PROPOSALS = "steer-proposals.jsonl";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const BAD_TEXT = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/;
const SLOTS_MAX = 1024;
const TEXT_MAX = 512;
const AUTHOR_MAX = 200;
const TASK_MAX = 4_000;

type Journal = typeof ACTIONS | typeof PROPOSALS;
interface Effect { kind: string; summary: string; [key: string]: unknown }
interface PlanEntry {
  source: Journal;
  line: number;
  id: string | null;
  action: string | null;
  status: string | null;
  requested_by: string | null;
  decision: "apply" | "refuse";
  effect: Effect | null;
  refusal: string | null;
}

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max && /\S/.test(value);

/** Required subject fields per action, kept per journal on purpose: the two
 *  writers use different verbs ("slots" in actions, "set-slots" in proposals). */
const SUBJECTS: Record<Journal, Record<string, string[]>> = {
  [ACTIONS]: {
    pause: ["lane"], resume: ["lane"], kill: ["job_id"],
    reassign: ["job_id", "lane"], slots: ["lane", "slots"], steer: ["job_id", "message"],
  },
  [PROPOSALS]: {
    reassign: ["job_id", "lane"], "set-slots": ["lane", "slots"], spawn: ["repo", "task"],
  },
};

/** Field-level refusal, or null when the value is usable. */
function fieldProblem(field: string, value: unknown): string | null {
  switch (field) {
    case "lane":
    case "job_id":
      return typeof value === "string" && IDENTIFIER.test(value) ? null : `invalid ${field}`;
    case "slots":
      if (!Number.isInteger(value) || (value as number) < 0) return "invalid slots";
      return (value as number) > SLOTS_MAX ? `slots ${value} exceeds ceiling ${SLOTS_MAX}` : null;
    case "message":
      return text(value, TEXT_MAX) ? null : "invalid message";
    case "repo":
      return typeof value === "string" && REPO.test(value) ? null : "invalid repo";
    case "task":
      return text(value, TASK_MAX) && !BAD_TEXT.test(value as string) ? null : "invalid task";
    default:
      return `invalid ${field}`;
  }
}

/** The change a valid request would make once an apply pass exists. */
function effectFor(record: Record<string, unknown>): Effect {
  switch (record.action) {
    case "pause":
      return { kind: "hold_lane", lane: record.lane, hold: "paused", summary: `pause lane ${record.lane}` };
    case "resume":
      return { kind: "release_lane", lane: record.lane, summary: `resume lane ${record.lane}` };
    case "kill":
      return { kind: "kill_job", job_id: record.job_id, summary: `kill job ${record.job_id}` };
    case "reassign":
      return { kind: "reassign_job", job_id: record.job_id, lane: record.lane, summary: `reassign job ${record.job_id} to lane ${record.lane}` };
    case "slots":
    case "set-slots":
      return { kind: "set_slots", lane: record.lane, slots: record.slots, summary: `set lane ${record.lane} slots to ${record.slots}` };
    case "steer":
      return { kind: "steer_job", job_id: record.job_id, message: record.message, summary: `steer job ${record.job_id}` };
    default:
      return { kind: "spawn_job", repo: record.repo, task: record.task, summary: `spawn ${record.repo}: ${String(record.task).slice(0, 80)}` };
  }
}

/** Pending means the writer queued it for review and no one settled it yet:
 *  actions require status "pending"; proposals stay pending until terminal. */
const isPending = (source: Journal, record: Record<string, unknown>) =>
  source === ACTIONS ? record.status === "pending"
    : !(typeof record.status === "string" && TERMINAL_STATUSES.has(record.status));

/** First reason a pending record cannot run, or null when it is plannable. */
function refusal(source: Journal, record: Record<string, unknown>): string | null {
  const action = record.action;
  if (typeof action !== "string" || !Object.hasOwn(SUBJECTS[source], action)) {
    return `unknown action ${JSON.stringify(action ?? null)}`;
  }
  // A pending record with dry_run still set is contradictory: previews never execute.
  if (source === ACTIONS && record.dry_run === true) return "dry_run request is not executable";
  const actor = source === ACTIONS ? record.requested_by : record.author;
  const actorMax = source === ACTIONS ? TEXT_MAX : AUTHOR_MAX;
  if (!text(actor, actorMax)) return source === ACTIONS ? "missing requested_by" : "missing author";
  // Reason is mandatory everywhere except spawn, where the writer made it optional.
  if (record.reason !== undefined && !text(record.reason, TEXT_MAX)) return "invalid reason";
  if (record.reason === undefined && (source === ACTIONS || action !== "spawn")) return "missing reason";
  for (const field of SUBJECTS[source][action]!) {
    if (!Object.hasOwn(record, field)) return `missing ${field}`;
    const problem = fieldProblem(field, record[field]);
    if (problem !== null) return problem;
  }
  return null;
}

function planJournal(root: string, source: Journal, plan: PlanEntry[]) {
  let read: JournalRead;
  try { read = readJournal(join(root, source)); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    return {
      records: 0, pending: 0, skipped: 0,
      error: message === "unsafe fleet journal" ? "unsafe" : message === "fleet journal too large" ? "too_large" : "unavailable",
    };
  }
  let pending = 0;
  for (const { record, line } of read.entries) {
    if (!isPending(source, record)) continue;
    pending += 1;
    const problem = refusal(source, record);
    plan.push({
      source, line,
      id: typeof record.id === "string" ? record.id : null,
      action: typeof record.action === "string" ? record.action : null,
      status: typeof record.status === "string" ? record.status : null,
      requested_by: typeof record.requested_by === "string" ? record.requested_by
        : typeof record.author === "string" ? record.author : null,
      decision: problem === null ? "apply" : "refuse",
      effect: problem === null ? effectFor(record) : null,
      refusal: problem,
    });
  }
  return { records: read.entries.length, pending, skipped: read.skipped, error: null };
}

export function fleetController(argv: string[], now = new Date(), root = defaultFleetRoot()) {
  const options = parseFlagPairs(argv, ["--root"], usage);
  const fleetRoot = resolve(options.get("--root") ?? root);
  const plan: PlanEntry[] = [];
  return {
    command: "plan" as const,
    root: fleetRoot,
    planned_at: now.toISOString(),
    journals: {
      [ACTIONS]: planJournal(fleetRoot, ACTIONS, plan),
      [PROPOSALS]: planJournal(fleetRoot, PROPOSALS, plan),
    },
    plan,
  };
}

if (import.meta.main) {
  void fleetCli(() => fleetController(process.argv.slice(2)),
    { error: "Controller plan failed: check arguments and file paths. No fleet file is ever written.", usage });
}
