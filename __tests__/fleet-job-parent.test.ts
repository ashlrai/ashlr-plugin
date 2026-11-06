import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobChildren, jobIdOf, jobParentId, type JobRecord } from "../servers/_job-lifecycle.ts";
import { fleetSession } from "../servers/fleet-session-server-handlers.ts";
import { fleetAct } from "../servers/fleet-actions-server-handlers.ts";
import { fleetController } from "../scripts/fleet-controller.ts";
import { fleetSpawn } from "../scripts/fleet-spawn.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-parent-")));
  roots.push(root);
  return root;
}
const writeJobs = (root: string, jobs: unknown[]) =>
  writeFileSync(join(root, "jobs.jsonl"), jobs.map(job => JSON.stringify(job)).join("\n") + "\n");
const journal = (root: string, file = "actions.jsonl") => {
  const path = join(root, file);
  return existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line))
    : [];
};
const audit = { requested_by: "router", reason: "tree stop" };
const kill = (root: string, job_id = "P", extra: Record<string, unknown> = {}) =>
  fleetAct({ ...audit, action: "kill", job_id, ...extra }, root);

describe("job parent links", () => {
  test("jobParentId reads parent_job_id then the parent alias, strings only", () => {
    expect(jobParentId({ parent_job_id: "RQ-P" })).toBe("RQ-P");
    expect(jobParentId({ parent: "RQ-P" })).toBe("RQ-P");
    expect(jobParentId({ parent_job_id: "", parent: "RQ-P" })).toBe("RQ-P");
    for (const value of [null, {}, { parent_job_id: 7 }, { parent_job_id: "" }, { parent: [] }, "x"] as const) {
      expect(jobParentId(value as JobRecord)).toBeUndefined();
    }
    expect(jobIdOf({ job_id: "A", id: "B", job: "C" })).toBe("A");
    expect(jobIdOf({ id: "B" })).toBe("B");
    expect(jobIdOf({ job: "C" })).toBe("C");
    expect(jobIdOf({})).toBeUndefined();
  });

  test("jobChildren folds the upsert stream last-wins and drops gone children", () => {
    const stream = [
      { id: "P", state: "running" },
      { id: "C1", parent_job_id: "P", state: "queued" },
      { id: "C2", parent: "P" },
      { id: "U", parent_job_id: "OTHER" },
      { id: "R", parent_job_id: "P" }, { id: "R", state: "running" },      // re-parented away
      { id: "M", parent_job_id: "P" }, { id: "M", parent_job_id: "Q" },   // moved to another parent
      { id: "D", parent_job_id: "P", state: "deleted" },
      { id: "F", parent_job_id: "P", deleted: true },
      { job_id: "S", parent_job_id: "S" },                               // self-parent never lists
      "not-an-object", null, [1, 2],
    ];
    const children = jobChildren(stream as JobRecord[], "P");
    expect(children.map(child => jobIdOf(child))).toEqual(["C1", "C2"]);
    expect(children[0]).toEqual({ id: "C1", parent_job_id: "P", state: "queued" });
    expect(jobChildren(stream as JobRecord[], "Q").map(child => jobIdOf(child))).toEqual(["M"]);
    expect(jobChildren(stream as JobRecord[], "NONE")).toEqual([]);
  });
});

describe("fleet_session parent listing", () => {
  test("returns the job plus its live children, and children of a missing job still list", () => {
    const root = fixture();
    mkdirSync(join(root, "logs"));
    writeJobs(root, [
      { id: "P", state: "running", metrics: { seconds: 3 } },
      { id: "P", state: "stalled" },                                     // last line wins for P
      { id: "C1", parent_job_id: "P", state: "running" },
      { id: "C2", parent_job_id: "P", state: "done" },
      { id: "D", parent_job_id: "P", state: "deleted" },
      { id: "U", state: "running" },
    ]);
    writeFileSync(join(root, "logs", "P.log"), "work\n");
    const session = fleetSession("P", root);
    expect(session.job).toMatchObject({ id: "P", state: "stalled" });
    expect(session.children.map((child: JobRecord) => child.id)).toEqual(["C1", "C2"]);
    expect(session.children[0]).toMatchObject({ parent_job_id: "P", state: "running" });
    // A job that is gone from the stream still lists what points at it.
    expect(fleetSession("GONE", root).children).toEqual([]);
    const orphan = fleetSession("C1", root);
    expect(orphan.job).toMatchObject({ id: "C1" });
    expect(orphan.children).toEqual([]);
  });

  test("an unreadable or invalid job stream reports the error and no children", () => {
    const root = fixture();
    writeFileSync(join(root, "jobs.jsonl"), '{"id":"P"}\nnot-json\n');
    const session = fleetSession("P", root);
    expect(session).toMatchObject({ job: null, children: [], errors: { job: "invalid" } });
  });
});

describe("fleet-spawn --parent", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  function spawnRoot() {
    const root = fixture();
    mkdirSync(join(root, "mirrors", "ashlrai__ashlr-plugin"), { recursive: true });
    return root;
  }
  const spawn = (root: string, args: string[]) => fleetSpawn(args, now, root);

  test("a valid --parent is journaled as parent_job_id on the spawn proposal", () => {
    const root = spawnRoot();
    const filed = spawn(root, ["triage the pulls", "--repo", "ashlrai/ashlr-plugin", "--parent", "RQ-PARENT.1"]);
    expect(filed.proposal).toMatchObject({ action: "spawn", parent_job_id: "RQ-PARENT.1" });
    expect(journal(root, "steer-proposals.jsonl")).toEqual([filed.proposal]);
    const unparented = spawn(root, ["other work", "--repo", "ashlrai/ashlr-plugin"]);
    expect(unparented.proposal).not.toHaveProperty("parent_job_id");
  });

  test("a malformed --parent is refused like any bad flag", () => {
    const root = spawnRoot();
    for (const parent of ["../escape", "a/b", "", "x".repeat(129), "-bad", "a\nb"]) {
      expect(() => spawn(root, ["work", "--repo", "ashlrai/ashlr-plugin", "--parent", parent])).toThrow();
    }
    // Same task under a different parent is a different proposal; an identical
    // pending one — parent included — is still refused.
    spawn(root, ["work", "--repo", "ashlrai/ashlr-plugin", "--parent", "RQ-A"]);
    expect(() => spawn(root, ["work", "--repo", "ashlrai/ashlr-plugin", "--parent", "RQ-A"])).toThrow("duplicate proposal");
    expect(() => spawn(root, ["work", "--repo", "ashlrai/ashlr-plugin", "--parent", "RQ-B"])).not.toThrow();
    expect(() => spawn(root, ["work", "--repo", "ashlrai/ashlr-plugin"])).not.toThrow();
  });
});

describe("kill cascade", () => {
  test("a kill appends exactly one cascade entry per live child, each a real kill request", () => {
    const root = fixture();
    writeJobs(root, [
      { id: "P", state: "running" },
      { id: "C1", parent_job_id: "P", state: "running" },
      { id: "C2", parent_job_id: "P", state: "queued" },
      { id: "C3", parent_job_id: "P", state: "done" },
      { id: "D", parent_job_id: "P", state: "deleted" },
      { id: "U", state: "running" },
      { id: "G", parent_job_id: "C1", state: "running" },                 // grandchild: not a child of P
      { id: "bad id", parent_job_id: "P" },                              // unkillable id is skipped
    ]);
    const parent = kill(root, "P", { dry_run: false });
    const lines = journal(root);
    expect(lines).toHaveLength(4);                                       // parent + C1, C2, C3
    expect(lines[0]).toEqual(parent);
    const cascades = lines.slice(1);
    expect(cascades.map(entry => entry.job_id)).toEqual(["C1", "C2", "C3"]);
    for (const entry of cascades) {
      expect(entry).toMatchObject({
        action: "kill", requested_by: "router", reason: "tree stop",
        dry_run: false, status: "pending", requested_at: parent.requested_at,
        cascade: { parent_job_id: "P", parent_request: parent.id },
      });
      expect(entry.id).not.toBe(parent.id);
    }
    // One entry per child: no duplicates, and every cascade names this request.
    expect(new Set(cascades.map(entry => entry.job_id)).size).toBe(cascades.length);
    // The controller plans each cascade entry as an ordinary pending kill.
    const plan = fleetController([], new Date(), root);
    expect(plan.journals["actions.jsonl"]).toMatchObject({ records: 4, pending: 4 });
    expect(plan.plan.map(entry => [entry.decision, entry.effect?.kind, entry.effect?.job_id])).toEqual([
      ["apply", "kill_job", "P"], ["apply", "kill_job", "C1"], ["apply", "kill_job", "C2"], ["apply", "kill_job", "C3"],
    ]);
  });

  test("a default dry-run kill previews the same cascade as dry_run entries", () => {
    const root = fixture();
    writeJobs(root, [{ id: "P", state: "running" }, { id: "C1", parent_job_id: "P" }, { id: "C2", parent_job_id: "P" }]);
    const parent = kill(root);
    const lines = journal(root);
    expect(lines).toHaveLength(3);
    for (const entry of lines) {
      expect(entry).toMatchObject({ status: "dry_run", dry_run: true });
    }
    expect(lines.slice(1).map(entry => entry.cascade)).toEqual([
      { parent_job_id: "P", parent_request: parent.id },
      { parent_job_id: "P", parent_request: parent.id },
    ]);
  });

  test("childless kills, missing and unreadable job logs append the parent record only", () => {
    const root = fixture();
    expect(journal(root).length).toBe(0);
    kill(root, "P");                                                     // no jobs.jsonl at all
    expect(journal(root).map(entry => entry.job_id)).toEqual(["P"]);
    writeFileSync(join(root, "jobs.jsonl"), "garbage");
    kill(root, "Q");                                                     // invalid stream: no cascade
    writeJobs(root, [{ id: "R" }, { id: "X", parent_job_id: "OTHER" }]);
    kill(root, "R");                                                     // no children of R
    expect(journal(root).map(entry => entry.job_id)).toEqual(["P", "Q", "R"]);
    // A non-kill action never cascades even when the lane has children.
    fleetAct({ ...audit, action: "pause", lane: "devin" }, root);
    expect(journal(root)).toHaveLength(4);
  });
});
