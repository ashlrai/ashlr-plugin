import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetController } from "../scripts/fleet-controller.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-controller-")));
  roots.push(root);
  writeFileSync(join(root, "targets.json"), JSON.stringify({ devin: 2 }));
  writeFileSync(join(root, "holds.json"), JSON.stringify({ devin: "paused" }));
  writeFileSync(join(root, "jobs.jsonl"), JSON.stringify({ job_id: "RQ-1", pool: "devin" }) + "\n");
  return root;
}
const now = new Date("2026-10-30T12:00:00Z");
const plan = (root: string, args: string[] = []) => fleetController(args, now, root);
const action = (record: Record<string, unknown>) => JSON.stringify({
  requested_by: "ui-panel", reason: "operator", dry_run: false,
  id: "act-1", requested_at: "2026-10-30T11:00:00.000Z", status: "pending", ...record,
});
const proposal = (record: Record<string, unknown>) => JSON.stringify({
  schema_version: 1, id: "prop-1", proposed_at: "2026-10-30T11:00:00.000Z",
  author: "router", reason: "rebalance", status: "proposed", ...record,
});
const write = (root: string, name: string, lines: string[]) =>
  writeFileSync(join(root, name), lines.join("\n") + (lines.length ? "\n" : ""));

/** Recursive relative-path -> file-bytes map; proves a read leaves no trace. */
function snapshot(root: string, prefix = ""): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(join(root, prefix)).sort()) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(join(root, rel)).isDirectory()) {
      for (const [key, value] of snapshot(root, rel)) files.set(key, value);
    } else files.set(rel, readFileSync(join(root, rel), "utf8"));
  }
  return files;
}
const expectUnchanged = (root: string, before: Map<string, string>) =>
  expect(snapshot(root)).toEqual(before);

test("a pending pause request plans a lane hold; dry_run previews are not pending", () => {
  const root = fixture();
  write(root, "actions.jsonl", [
    action({ action: "pause", lane: "devin" }),
    action({ action: "pause", lane: "ops", status: "dry_run", dry_run: true }),
    action({ action: "resume", lane: "devin", id: "act-2" }),
  ]);
  const before = snapshot(root);
  const out = plan(root);
  expect(out.command).toBe("plan");
  expect(out.planned_at).toBe("2026-10-30T12:00:00.000Z");
  expect(out.journals["actions.jsonl"]).toEqual({ records: 3, pending: 2, skipped: 0, error: null });
  expect(out.plan).toHaveLength(2);
  expect(out.plan[0]).toMatchObject({
    source: "actions.jsonl", line: 1, id: "act-1", action: "pause", status: "pending",
    requested_by: "ui-panel", decision: "apply", refusal: null,
    effect: { kind: "hold_lane", lane: "devin", hold: "paused" },
  });
  expect(out.plan[1]).toMatchObject({ line: 3, action: "resume", decision: "apply", effect: { kind: "release_lane", lane: "devin" } });
  expectUnchanged(root, before);
});

test("slots over the 1024 ceiling are refused in both journals; bounds still plan", () => {
  const root = fixture();
  write(root, "actions.jsonl", [
    action({ action: "slots", lane: "devin", slots: 2000, id: "over" }),
    action({ action: "slots", lane: "devin", slots: 1024, id: "ceiling" }),
    action({ action: "slots", lane: "devin", slots: -1, id: "negative" }),
    action({ action: "slots", lane: "devin", slots: 2.5, id: "fractional" }),
  ]);
  write(root, "steer-proposals.jsonl", [
    proposal({ action: "set-slots", lane: "devin", slots: 4096 }),
    proposal({ action: "set-slots", lane: "devin", slots: 0 }),
  ]);
  const before = snapshot(root);
  const out = plan(root);
  const byId = new Map(out.plan.map(entry => [entry.id, entry]));
  expect(byId.get("over")).toMatchObject({ decision: "refuse", effect: null });
  expect(byId.get("over")!.refusal).toContain("exceeds ceiling 1024");
  expect(byId.get("ceiling")).toMatchObject({ decision: "apply", effect: { kind: "set_slots", slots: 1024 } });
  expect(byId.get("negative")!.decision).toBe("refuse");
  expect(byId.get("fractional")!.decision).toBe("refuse");
  const proposals = out.plan.filter(entry => entry.source === "steer-proposals.jsonl");
  expect(proposals[0]).toMatchObject({ decision: "refuse", refusal: "slots 4096 exceeds ceiling 1024" });
  expect(proposals[1]).toMatchObject({ decision: "apply", effect: { kind: "set_slots", slots: 0 } });
  expectUnchanged(root, before);
});

test("a spawn proposal plans a spawn effect for the enrolled repo task", () => {
  const root = fixture();
  write(root, "steer-proposals.jsonl", [
    proposal({ action: "spawn", repo: "ashlrai/ashlr-plugin", task: "triage the dirty pulls", reason: undefined }),
    proposal({ action: "reassign", job_id: "RQ-1", lane: "devin" }),
  ]);
  const before = snapshot(root);
  const out = plan(root);
  expect(out.plan[0]).toMatchObject({
    source: "steer-proposals.jsonl", line: 1, action: "spawn", requested_by: "router",
    decision: "apply", effect: { kind: "spawn_job", repo: "ashlrai/ashlr-plugin", task: "triage the dirty pulls" },
  });
  expect(out.plan[1]).toMatchObject({ decision: "apply", effect: { kind: "reassign_job", job_id: "RQ-1", lane: "devin" } });
  expectUnchanged(root, before);
});

test("malformed journal lines are counted as skipped, never planned", () => {
  const root = fixture();
  write(root, "actions.jsonl", [
    "not-json", "[1,2,3]", "null", '"a string"', "42",
    action({ action: "kill", job_id: "RQ-1" }),
    "{broken",
  ]);
  write(root, "steer-proposals.jsonl", ["{}", "   ", proposal({ action: "spawn", repo: "a/b", task: "x" })]);
  const before = snapshot(root);
  const out = plan(root);
  expect(out.journals["actions.jsonl"]).toEqual({ records: 1, pending: 1, skipped: 6, error: null });
  // "{}" parses but has no status, so it counts as a pending proposal and is refused.
  expect(out.journals["steer-proposals.jsonl"]).toEqual({ records: 2, pending: 2, skipped: 0, error: null });
  expect(out.plan.map(entry => entry.decision)).toEqual(["apply", "refuse", "apply"]);
  // Plan lines are physical journal lines: the kill is line 6, "{}" is line 1.
  expect(out.plan.map(entry => [entry.source, entry.line])).toEqual([
    ["actions.jsonl", 6], ["steer-proposals.jsonl", 1], ["steer-proposals.jsonl", 3],
  ]);
  expect(out.plan[1]!.refusal).toBe("unknown action null");
  expectUnchanged(root, before);
});

test("terminal proposals and settled actions are not planned; journals stay byte-identical", () => {
  const root = fixture();
  const actions = [
    action({ action: "kill", job_id: "RQ-1", status: "applied" }),
    action({ action: "steer", job_id: "RQ-1", message: "focus the diff" }),
  ];
  const proposals = [
    proposal({ action: "set-slots", lane: "devin", slots: 4, status: "applied" }),
    proposal({ action: "set-slots", lane: "devin", slots: 4, status: "rejected" }),
    proposal({ action: "set-slots", lane: "devin", slots: 4, status: "withdrawn" }),
    proposal({ action: "set-slots", lane: "devin", slots: 4, status: "superseded" }),
    proposal({ action: "steer", job_id: "RQ-1", message: "x" }),
  ];
  write(root, "actions.jsonl", actions);
  write(root, "steer-proposals.jsonl", proposals);
  const before = snapshot(root);
  const out = plan(root);
  expect(out.plan).toHaveLength(2);
  expect(out.plan[0]).toMatchObject({ action: "steer", decision: "apply", effect: { kind: "steer_job", job_id: "RQ-1" } });
  // "steer" is not a proposal verb, so the pending proposal record is refused.
  expect(out.plan[1]).toMatchObject({ decision: "refuse", refusal: 'unknown action "steer"' });
  expectUnchanged(root, before);
  // A second plan is identical and still writes nothing.
  expect(plan(root)).toEqual(out);
  expectUnchanged(root, before);
});

test("missing fields, missing attribution and unknown actions refuse with reasons", () => {
  const root = fixture();
  write(root, "actions.jsonl", [
    action({ action: "pause" }),                       // missing lane
    action({ action: "reassign", job_id: "RQ-1" }),    // missing lane
    action({ action: "kill", job_id: "../escape" }),   // invalid job_id
    action({ action: "explode", lane: "devin" }),      // unknown action
    action({ action: "pause", lane: "devin", requested_by: undefined, reason: undefined }),
    action({ action: "pause", lane: "devin", dry_run: true }), // contradictory preview
    action({ action: "pause", lane: "devin", reason: 5 }),
  ]);
  const before = snapshot(root);
  const out = plan(root);
  expect(out.plan.map(entry => entry.refusal)).toEqual([
    "missing lane", "missing lane", "invalid job_id", 'unknown action "explode"',
    "missing requested_by", "dry_run request is not executable", "invalid reason",
  ]);
  expect(out.plan.every(entry => entry.decision === "refuse" && entry.effect === null)).toBe(true);
  expectUnchanged(root, before);
});

test("proposals validate author, repo and task; spawn tolerates a missing reason", () => {
  const root = fixture();
  write(root, "steer-proposals.jsonl", [
    proposal({ action: "spawn", repo: "not a repo", task: "work" }),
    proposal({ action: "spawn", repo: "ashlrai/locus", task: "" }),
    proposal({ action: "spawn", repo: "ashlrai/locus", task: "x".repeat(4001) }),
    proposal({ action: "set-slots", lane: "devin", slots: 2, author: undefined }),
    proposal({ action: "reassign", job_id: "RQ-1", lane: "devin", reason: undefined }),
    proposal({ action: "spawn", repo: "ashlrai/locus", task: "legit", reason: undefined }),
  ]);
  const before = snapshot(root);
  const out = plan(root);
  expect(out.plan.map(entry => entry.refusal)).toEqual([
    "invalid repo", "invalid task", "invalid task", "missing author", "missing reason", null,
  ]);
  expectUnchanged(root, before);
});

test("missing journals plan nothing and create no files, even for a missing root", () => {
  const root = join(fixture(), "absent");
  const out = plan(root);
  expect(out.plan).toEqual([]);
  for (const journal of Object.values(out.journals)) {
    expect(journal).toEqual({ records: 0, pending: 0, skipped: 0, error: null });
  }
  expect(existsSync(root)).toBe(false);
});

test("unsafe journals are reported per journal without failing the plan", () => {
  const root = fixture(), target = join(root, "targets.json");
  for (const link of [symlinkSync, linkSync]) {
    const journal = join(root, "actions.jsonl");
    link(target, journal);
    write(root, "steer-proposals.jsonl", [proposal({ action: "reassign", job_id: "RQ-1", lane: "devin" })]);
    const before = snapshot(root);
    const out = plan(root);
    expect(out.journals["actions.jsonl"]!.error).toBe("unsafe");
    expect(out.journals["steer-proposals.jsonl"]!.error).toBeNull();
    expect(out.plan).toHaveLength(1);
    expect(readFileSync(target, "utf8")).toBe('{"devin":2}');
    expectUnchanged(root, before);
    rmSync(journal);
  }
});

test("only --root is accepted; the controller has no apply or output flags", () => {
  const root = fixture();
  for (const args of [["plan"], ["--apply"], ["--output", "x"], ["--root"], ["--root", root, "--root", root], ["--root", root, "extra"], ["-h"]]) {
    expect(() => fleetController(args as string[], now, root)).toThrow();
  }
  expect(plan(root, ["--root", root]).command).toBe("plan");
});

test("CLI emits a parseable JSON plan on stdout and refuses bad arguments", () => {
  const root = fixture(), script = join(import.meta.dir, "../scripts/fleet-controller.ts");
  write(root, "actions.jsonl", [action({ action: "pause", lane: "devin" })]);
  write(root, "steer-proposals.jsonl", [proposal({ action: "spawn", repo: "a/b", task: "work" })]);
  const before = snapshot(root);
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, script, ...args]);
  const ok = run("--root", root);
  expect(ok.exitCode).toBe(0);
  const out = JSON.parse(ok.stdout.toString());
  expect(out.command).toBe("plan");
  expect(out.plan).toHaveLength(2);
  expect(ok.stderr.toString()).toBe("");
  // Bare invocation plans the default root; flag junk exits nonzero with JSON.
  expect(run("--apply").exitCode).toBe(1);
  expect(JSON.parse(run("--apply").stderr.toString()).error).toContain("Controller plan failed");
  expectUnchanged(root, before);
});
