/**
 * _job-lifecycle.ts — the legal job state machine for the fleet job stream.
 *
 * metrics/jobs.jsonl is an append-only typed event feed and jobs.jsonl upserts
 * reuse the same names via `state`; every reader today re-derives "current
 * state" by taking the last matching line, so a stale `running` silently
 * overwrites a `merged`. JOB_LIFECYCLE declares each legal transition once and
 * applyJobEvent is the adjudicator: illegal transitions are logged no-ops and
 * the reducer never throws.
 *
 * Event names are the names found in the streams: new, queued,
 * dispatched/dispatch, started, running, retried, stalled, updated,
 * done/finished, merged, failed, killed, deleted — plus `outcome`, a record
 * type whose `state` field carries the real transition (e.g. MERGED).
 *
 * Jobs also form trees: a record's `parent_job_id` (alias `parent`) names the
 * job that spawned it. jobChildren applies the readers' last-wins upsert rule
 * to list a job's live children — the set a kill cascade fans out to.
 */

/** Canonical job states; no known state is the implicit start. */
export const JOB_STATES = [
  "new", "queued", "dispatched", "running", "stalled",
  "done", "merged", "failed", "killed", "deleted",
] as const;
export type JobState = typeof JOB_STATES[number];

/** States after which no execution event is legal. `done` still accepts `merged`. */
export const FINAL_JOB_STATES = ["done", "merged", "failed", "killed", "deleted"] as const satisfies readonly JobState[];

export type JobRecord = Record<string, unknown>;

/** Supersession predicate; every listed guard must hold for a transition to apply. */
export type JobGuard = (job: Readonly<JobRecord>) => boolean;

const KNOWN_STATES = new Set<string>(JOB_STATES);

/** Canonical current state, or undefined when the job carries none we know. */
export function jobStateOf(job: Readonly<JobRecord> | null | undefined): JobState | undefined {
  if (!job || typeof job !== "object") return undefined;
  const raw = job.state ?? job.status;
  if (typeof raw !== "string") return undefined;
  const state = raw.trim().toLowerCase();
  return KNOWN_STATES.has(state) ? state as JobState : undefined;
}

export const notKilled: JobGuard = job => jobStateOf(job) !== "killed";
export const notDeleted: JobGuard = job => jobStateOf(job) !== "deleted" && job.deleted !== true;

/** Job-id key order shared by the stream readers: job_id, then id, then job. */
export function jobIdOf(job: Readonly<JobRecord> | null | undefined): string | undefined {
  if (!job || typeof job !== "object") return undefined;
  const id = job.job_id ?? job.id ?? job.job;
  return typeof id === "string" && id.length ? id : undefined;
}

/**
 * Canonical parent link. `parent_job_id` is the declared field — spawn
 * proposals write it and jobs.jsonl carries it; `parent` is accepted as the
 * stream alias so older rows still join.
 */
export function jobParentId(job: Readonly<JobRecord> | null | undefined): string | undefined {
  if (!job || typeof job !== "object") return undefined;
  for (const key of ["parent_job_id", "parent"] as const) {
    const parent = job[key];
    if (typeof parent === "string" && parent.length) return parent;
  }
  return undefined;
}

/**
 * Latest record per job whose parent link names `parentId`, in first-seen
 * order. jobs.jsonl is an upsert stream — the last line per id wins, so a
 * re-parented child drops out — and a deleted record is gone, not a child.
 * A job never lists itself, even when a row points at its own id.
 */
export function jobChildren(records: Iterable<Readonly<JobRecord> | null | undefined>, parentId: string): JobRecord[] {
  const latest = new Map<string, JobRecord>();
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const id = jobIdOf(record);
    if (id !== undefined) latest.set(id, record as JobRecord);
  }
  latest.delete(parentId);
  return [...latest.values()].filter(job => jobParentId(job) === parentId && notDeleted(job));
}

export interface JobTransitionRule {
  /** Known states the event may fire from; a job with no known state accepts any declared event. */
  from: readonly JobState[];
  /** Target state; null refreshes in place without a state change. */
  to: JobState | null;
  when: readonly JobGuard[];
}

const LIVE: readonly JobGuard[] = [notKilled, notDeleted];
const ACTIVE: readonly JobState[] = ["new", "queued", "dispatched", "running", "stalled"];

export const JOB_LIFECYCLE: Readonly<Record<string, JobTransitionRule>> = {
  new:        { from: ["new"],                            to: "new",        when: LIVE },
  queued:     { from: ["new", "queued"],                  to: "queued",     when: LIVE },
  dispatched: { from: ["queued", "dispatched"],           to: "dispatched", when: LIVE },
  dispatch:   { from: ["queued", "dispatched"],           to: "dispatched", when: LIVE },
  started:    { from: ["queued", "dispatched", "running"], to: "running",   when: LIVE },
  running:    { from: ["queued", "dispatched", "running", "stalled"], to: "running", when: LIVE },
  retried:    { from: ["queued", "dispatched", "running", "stalled", "failed"], to: "queued", when: LIVE },
  stalled:    { from: ["running", "stalled"],             to: "stalled",    when: LIVE },
  updated:    { from: ACTIVE,                             to: null,         when: LIVE },
  done:       { from: ACTIVE,                             to: "done",       when: LIVE },
  finished:   { from: ACTIVE,                             to: "done",       when: LIVE },
  merged:     { from: ["running", "stalled", "done"],     to: "merged",     when: LIVE },
  failed:     { from: ACTIVE,                             to: "failed",     when: LIVE },
  killed:     { from: ACTIVE,                             to: "killed",     when: LIVE },
  deleted:    { from: JOB_STATES.filter(s => s !== "deleted"), to: "deleted", when: [notDeleted] },
};

export interface JobEventResult {
  /** Record with the transition applied; the same object when rejected or refreshed. */
  job: JobRecord;
  applied: boolean;
  /** Resolved event name (lowercased, post-alias), null when unresolvable. */
  event: string | null;
  /** State before; null = no known state (initial). */
  from: JobState | null;
  /** State after; equals `from` on refresh or rejection. */
  to: JobState | null;
  reason?: "unknown_event" | "illegal_transition" | "guard_rejected";
}

/**
 * Resolve a canonical event name from a bare name or a stream record using the
 * readers' alias order (type → event → state → status). `outcome` rows carry
 * the real transition in `state`.
 */
export function jobEventName(event: string | Readonly<JobRecord>): string | null {
  if (typeof event === "string") return event.trim().toLowerCase() || null;
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const name = ["type", "event", "state", "status"]
    .map(key => event[key]).find(value => typeof value === "string" && value.length);
  if (typeof name !== "string") return null;
  const lower = name.trim().toLowerCase();
  if (lower === "outcome" && typeof event.state === "string" && event.state.length)
    return event.state.trim().toLowerCase() || null;
  return lower;
}

function idOf(job: Readonly<JobRecord>): string {
  const id = jobIdOf(job);
  return id === undefined ? "(unknown)" : id.replace(/[^\w.-]+/g, "?").slice(0, 64);
}

/**
 * Adjudicate one event. Legal transitions return a new record with `state`
 * updated (input is never mutated); everything else is a logged no-op that
 * returns the input unchanged. Never throws.
 */
export function applyJobEvent(
  job: Readonly<JobRecord> | null | undefined,
  event: string | Readonly<JobRecord>,
  log: (message: string) => void = message => console.error(message),
): JobEventResult {
  const record: JobRecord = job && typeof job === "object" && !Array.isArray(job) ? job as JobRecord : {};
  const from = jobStateOf(record) ?? null;
  const reject = (name: string | null, reason: NonNullable<JobEventResult["reason"]>): JobEventResult => {
    try { log(`job-lifecycle: ignored ${JSON.stringify(name)} for ${idOf(record)}: ${reason} (state=${from ?? "initial"})`); }
    catch { /* logging must not crash the reducer */ }
    return { job: record, applied: false, event: name, from, to: from, reason };
  };
  try {
    const name = jobEventName(event);
    if (name === null) return reject(null, "unknown_event");
    const rule = JOB_LIFECYCLE[name];
    if (!rule) return reject(name, "unknown_event");
    if (from !== null && !rule.from.includes(from)) return reject(name, "illegal_transition");
    for (const guard of rule.when) {
      let ok = false;
      try { ok = guard(record); } catch { ok = false; }
      if (!ok) return reject(name, "guard_rejected");
    }
    if (rule.to === null) return { job: record, applied: true, event: name, from, to: from };
    return { job: { ...record, state: rule.to }, applied: true, event: name, from, to: rule.to };
  } catch {
    return { job: record, applied: false, event: null, from, to: from, reason: "unknown_event" };
  }
}

/** Mermaid rendering of JOB_LIFECYCLE; regenerate docs/job-lifecycle.md when it changes. */
export function jobLifecycleMermaid(): string {
  const lines = ["stateDiagram-v2", "  [*] --> new"];
  for (const [name, rule] of Object.entries(JOB_LIFECYCLE))
    for (const from of rule.from) lines.push(`  ${from} --> ${rule.to ?? from}: ${name}`);
  for (const state of FINAL_JOB_STATES) lines.push(`  ${state} --> [*]`);
  return lines.join("\n");
}

/** Generated markdown pairing the table with its diagram; asserted by __tests__/fleet-lifecycle.test.ts. */
export function renderJobLifecycleDoc(): string {
  return [
    "<!-- Generated by servers/_job-lifecycle.ts (renderJobLifecycleDoc). Regenerate:",
    "     bun -e 'import { renderJobLifecycleDoc } from \"./servers/_job-lifecycle.ts\"; process.stdout.write(renderJobLifecycleDoc())' > docs/job-lifecycle.md -->",
    "",
    "# Job lifecycle",
    "",
    "Legal transitions over the event names found in `metrics/jobs.jsonl` (and the",
    "fleet `jobs.jsonl` `state` field, which uses the same names). `applyJobEvent` in",
    "`servers/_job-lifecycle.ts` is the adjudicator: illegal transitions are logged",
    "no-ops, never crashes. Killed and deleted jobs reject every further event via",
    "the `notKilled`/`notDeleted` supersession predicates; `done` still accepts",
    "`merged` so a finished job's PR can land. Jobs may carry `parent_job_id`",
    "(alias `parent`) naming the job that spawned them; `jobChildren` folds the",
    "same last-wins stream into a job's live children, which is what a kill",
    "cascade in `fleet-actions-server-handlers.ts` fans a parent kill out to.",
    "",
    "```mermaid",
    jobLifecycleMermaid(),
    "```",
    "",
  ].join("\n");
}
