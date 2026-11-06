import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyJobEvent,
  FINAL_JOB_STATES,
  JOB_LIFECYCLE,
  JOB_STATES,
  jobEventName,
  jobLifecycleMermaid,
  jobStateOf,
  renderJobLifecycleDoc,
  type JobRecord,
  type JobState,
} from "../servers/_job-lifecycle.ts";

const job = (state?: string, extra: JobRecord = {}): JobRecord => ({ job_id: "RQ-1", ...(state === undefined ? {} : { state }), ...extra });

/** Capture rejections; applyJobEvent must log a no-op, never throw. */
function captured() {
  const messages: string[] = [];
  return { log: (m: string) => { messages.push(m); }, messages };
}

describe("JOB_LIFECYCLE", () => {
  test("every legal transition applies from each declared source state", () => {
    for (const [name, rule] of Object.entries(JOB_LIFECYCLE)) {
      for (const from of rule.from) {
        const { log, messages } = captured();
        const result = applyJobEvent(job(from), name, log);
        expect(result.applied, `${name} from ${from}`).toBe(true);
        expect(jobStateOf(result.job)).toBe(rule.to ?? from);
        expect(result.from).toBe(from);
        expect(result.to).toBe(rule.to ?? from);
        expect(messages).toEqual([]);
      }
    }
  });

  test("every declared event applies to a job with no known state", () => {
    for (const name of Object.keys(JOB_LIFECYCLE)) {
      const result = applyJobEvent(job(), name, () => {});
      expect(result.applied, name).toBe(true);
      expect(result.from).toBeNull();
      expect(result.to).toBe(JOB_LIFECYCLE[name]!.to);
    }
  });

  test("non-final repeats are idempotent but final states lock out their own event", () => {
    for (const [name, rule] of Object.entries(JOB_LIFECYCLE)) {
      if (rule.to === null) continue;
      const result = applyJobEvent(job(rule.to), name, () => {});
      const terminal = (FINAL_JOB_STATES as readonly JobState[]).includes(rule.to);
      expect(result.applied, `${name} while ${rule.to}`).toBe(!terminal);
    }
  });

  test("rejects out-of-order events as logged no-ops", () => {
    const cases: [string, string][] = [
      ["merged", "running"],   // merged is final: a stale running cannot win
      ["merged", "done"],
      ["running", "queued"],   // queueing is only legal pre-dispatch
      ["running", "dispatched"],
      ["stalled", "queued"],
      ["dispatched", "stalled"],
      ["done", "failed"],
      ["failed", "merged"],
      ["new", "retried"],      // a job that never ran cannot retry
    ];
    for (const [state, event] of cases) {
      const { log, messages } = captured();
      const before = job(state);
      const result = applyJobEvent(before, event, log);
      expect(result.applied, `${state} -> ${event}`).toBe(false);
      expect(result.reason).toBe("illegal_transition");
      expect(result.job).toBe(before);
      expect(result.to).toBe(state as JobState);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(event);
      expect(messages[0]).toContain("RQ-1");
    }
  });

  test("a job finishing twice is rejected whether it ends done, merged, failed or killed", () => {
    for (const [first, second] of [["done", "done"], ["done", "finished"], ["merged", "done"], ["merged", "merged"], ["failed", "done"], ["killed", "merged"]]) {
      const { log, messages } = captured();
      const after = applyJobEvent(job(), first, log).job;
      const result = applyJobEvent(after, second, log);
      expect(result.applied, `${first} then ${second}`).toBe(false);
      expect(result.to).toBe(JOB_LIFECYCLE[first]!.to);
      expect(messages).toHaveLength(1);
    }
  });

  test("killed and deleted jobs supersede every further event", () => {
    for (const state of ["killed", "deleted"]) {
      for (const name of Object.keys(JOB_LIFECYCLE)) {
        if (name === "deleted") continue;
        const result = applyJobEvent(job(state), name, () => {});
        expect(result.applied, `${state} -> ${name}`).toBe(false);
      }
    }
    expect(applyJobEvent(job("killed"), "deleted", () => {}).applied).toBe(true); // tombstoning survives
    expect(applyJobEvent(job("deleted"), "deleted", () => {}).applied).toBe(false);
    expect(applyJobEvent(job("running", { deleted: true }), "done", () => {}).reason).toBe("guard_rejected");
  });

  test("resolves stream records by alias order and outcome rows by state", () => {
    expect(jobEventName({ type: "started" })).toBe("started");
    expect(jobEventName({ event: "new", state: "done" })).toBe("new");
    expect(jobEventName({ status: "done" })).toBe("done");
    expect(jobEventName({ event: "outcome", state: "MERGED" })).toBe("merged");
    expect(applyJobEvent(job("running"), { event: "outcome", state: "MERGED" }, () => {}).to).toBe("merged");
    expect(applyJobEvent(job("done"), { event: "outcome", state: "FAILED" }, () => {}).applied).toBe(false);
    expect(jobEventName({})).toBeNull();
    expect(jobEventName({ job_id: "RQ-1" })).toBeNull();
  });

  test("updated refreshes in place and aliases land on canonical states", () => {
    const before = job("running", { pool: "codex" });
    const result = applyJobEvent(before, "updated", () => {});
    expect(result.applied).toBe(true);
    expect(result.job).toBe(before); // refresh mutates nothing
    expect(jobStateOf(applyJobEvent(job("dispatched"), "dispatch", () => {}).job)).toBe("dispatched");
    expect(jobStateOf(applyJobEvent(job("dispatched"), "finished", () => {}).job)).toBe("done");
    expect(jobStateOf(applyJobEvent(job("dispatched"), "started", () => {}).job)).toBe("running");
  });

  test("never throws or mutates on garbage input", () => {
    const frozen = Object.freeze(job("running", { nested: { a: 1 } }));
    const snapshot = JSON.stringify(frozen);
    for (const [j, e] of [
      [null, "done"], [undefined, "done"], [42, "running"], ["x", "done"], [[], "done"],
      [frozen, "done"], [frozen, 42], [frozen, null], [frozen, []], [frozen, {}], [frozen, "exploded"],
    ] as const) {
      const result = applyJobEvent(j as JobRecord, e as string, () => {});
      expect(result.applied === true || result.job !== undefined).toBe(true);
    }
    expect(JSON.stringify(frozen)).toBe(snapshot);
    const applied = applyJobEvent(frozen, "done", () => {});
    expect(applied.job).not.toBe(frozen);
    expect(JSON.stringify(frozen)).toBe(snapshot); // pure: input untouched
    expect(jobStateOf(applied.job)).toBe("done");
    for (const bad of [null, 5, {}, "no such event"]) {
      const result = applyJobEvent(job("running"), bad as string, () => {});
      expect(result.applied).toBe(false);
    }
  });

  test("the default logger writes rejections to stderr without crashing", () => {
    const original = console.error;
    const seen: string[] = [];
    console.error = (m?: unknown) => { seen.push(String(m)); };
    try {
      expect(applyJobEvent(job("merged"), "running").applied).toBe(false);
      expect(applyJobEvent(job("running"), "done").applied).toBe(true);
      expect(seen).toHaveLength(1);
    } finally { console.error = original; }
  });
});

describe("generated diagram", () => {
  test("mermaid covers every declared transition and every state", () => {
    const mermaid = jobLifecycleMermaid();
    expect(mermaid).toStartWith("stateDiagram-v2");
    for (const state of JOB_STATES) expect(mermaid).toContain(state);
    for (const [name, rule] of Object.entries(JOB_LIFECYCLE))
      for (const from of rule.from) expect(mermaid).toContain(`${from} --> ${rule.to ?? from}: ${name}`);
    for (const state of FINAL_JOB_STATES) expect(mermaid).toContain(`${state} --> [*]`);
  });

  test("docs/job-lifecycle.md is in lockstep with the table", () => {
    const doc = readFileSync(join(import.meta.dir, "../docs/job-lifecycle.md"), "utf8");
    expect(doc).toBe(renderJobLifecycleDoc());
  });
});
