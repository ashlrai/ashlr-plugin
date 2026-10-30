import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetSteer } from "../scripts/fleet-steer.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-steer-")));
  roots.push(root);
  writeFileSync(join(root, "targets.json"), JSON.stringify({ dev: 2, "codex-personal": 1 }));
  writeFileSync(join(root, "holds.json"), JSON.stringify({ dev: "paused" }));
  writeFileSync(join(root, "jobs.jsonl"), [
    { job_id: "RQ-1", pool: "dev" }, { job_id: "RQ-2", lane: "ops" }, { id: "RQ-1", pool: "ops" },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  return root;
}
const now = new Date("2026-10-30T12:00:00Z");
const steer = (root: string, args: string[]) => fleetSteer(args, now, root);
const proposeResult = (value: ReturnType<typeof fleetSteer>) => {
  if (value.command !== "propose") throw new Error("expected propose result");
  return value;
};
const reassign = (root: string, extra: string[] = []) => proposeResult(steer(root, [
  "propose", "--root", root, "--action", "reassign", "--job-id", "RQ-1", "--lane", "devin",
  "--author", "router", "--reason", "rebalance", ...extra,
]));
const setSlots = (root: string, slots = "4", extra: string[] = []) => proposeResult(steer(root, [
  "propose", "--root", root, "--action", "set-slots", "--lane", "dev", "--slots", slots,
  "--author", "router", "--reason", "rebalance", ...extra,
]));

test("lanes reads targets, holds and per-lane job counts without creating proposals", () => {
  const root = fixture();
  expect(steer(root, ["lanes"])).toMatchObject({
    command: "lanes", errors: { "leader-events.jsonl": "missing" },
    lanes: {
      dev: { target: 2, hold: "paused", jobs: 0 },
      "codex-personal": { target: 1, hold: null, jobs: 0 },
      ops: { target: null, hold: null, jobs: 2 },
    },
  });
  expect(existsSync(join(root, "steer-proposals.jsonl"))).toBe(false);
});

test("proposals appends audited records preserving prior bytes, returning journal reads", () => {
  const root = fixture(), output = join(root, "steer-proposals.jsonl");
  writeFileSync(output, '{"legacy":true}\nnot-json\n');
  const moved = reassign(root);
  const sized = setSlots(root, "3");
  expect(moved.proposal).toMatchObject({
    schema_version: 1, action: "reassign", job_id: "RQ-1", lane: "devin",
    author: "router", reason: "rebalance", status: "proposed",
    proposed_at: "2026-10-30T12:00:00.000Z", observed: { target: null, hold: null, job_lane: "ops" },
  });
  expect(sized.proposal).toMatchObject({ action: "set-slots", lane: "dev", slots: 3, observed: { target: 2, hold: "paused" } });
  expect(moved.proposal.id).not.toBe(sized.proposal.id);
  const lines = readFileSync(output, "utf8").split("\n");
  expect(lines[0]).toBe('{"legacy":true}');
  expect(lines.at(-2)).toBe(JSON.stringify(sized.proposal));
  expect(lines.at(-3)).toBe(JSON.stringify(moved.proposal));
  const listed = steer(root, ["proposals"]);
  if (listed.command !== "proposals") throw new Error("expected proposals result");
  expect(listed.proposals).toEqual([{ legacy: true }, moved.proposal, sized.proposal]);
  expect(listed.skipped).toBe(1);
  for (const file of ["targets.json", "holds.json", "jobs.jsonl"]) expect(readFileSync(join(root, file), "utf8")).not.toContain("steer");
});

test("invalid lanes and job ids are refused before any journal or directory is created", () => {
  const root = join(fixture(), "missing");
  for (const lane of ["../escape", "a/b", "a\\b", "with space", "", "-lead", ".dot", "x".repeat(129), "x\ny"]) {
    expect(() => fleetSteer(["propose", "--root", root, "--action", "reassign", "--job-id", "RQ-1", "--lane", lane,
      "--author", "router", "--reason", "r"], now, root)).toThrow();
    expect(() => fleetSteer(["propose", "--root", root, "--action", "set-slots", "--lane", lane, "--slots", "2",
      "--author", "router", "--reason", "r"], now, root)).toThrow();
  }
  for (const job of ["../escape", "a/b", "", "x".repeat(129)]) {
    expect(() => fleetSteer(["propose", "--root", root, "--action", "reassign", "--job-id", job, "--lane", "dev",
      "--author", "router", "--reason", "r"], now, root)).toThrow();
  }
  expect(existsSync(root)).toBe(false);
});

test("out-of-range slot targets are refused; 0 and 1024 are the inclusive bounds", () => {
  const root = fixture();
  for (const slots of ["-1", "1025", "1.5", "1e3", "abc", "", "0x10", "9999999999999999999999"]) {
    expect(() => setSlots(root, slots)).toThrow();
  }
  expect(existsSync(join(root, "steer-proposals.jsonl"))).toBe(false);
  expect(setSlots(root, "0").proposal).toMatchObject({ slots: 0 });
  expect(setSlots(root, "1024").proposal).toMatchObject({ slots: 1024 });
});

test("an identical pending proposal is refused but distinct proposals coexist", () => {
  const root = fixture();
  reassign(root);
  expect(() => reassign(root)).toThrow("duplicate proposal");
  expect(() => steer(root, ["propose", "--action", "reassign", "--job-id", "RQ-1", "--lane", "devin",
    "--author", "other", "--reason", "different reason"])).toThrow("duplicate proposal");
  expect(() => setSlots(root, "4")).not.toThrow();
  expect(() => setSlots(root, "4")).toThrow("duplicate proposal");
  setSlots(root, "5");
  steer(root, ["propose", "--action", "reassign", "--job-id", "RQ-2", "--lane", "devin",
    "--author", "router", "--reason", "same lane, different job"]);
  expect(readFileSync(join(root, "steer-proposals.jsonl"), "utf8").trim().split("\n")).toHaveLength(4);
});

test("applied or rejected proposals no longer block a fresh identical proposal", () => {
  const root = fixture();
  writeFileSync(join(root, "steer-proposals.jsonl"),
    JSON.stringify({ action: "set-slots", lane: "dev", slots: 3, status: "applied" }) + "\n" +
    JSON.stringify({ action: "reassign", job_id: "RQ-9", lane: "dev", status: "rejected" }) + "\n");
  const slots = setSlots(root, "3");
  const reassigned = proposeResult(steer(root, ["propose", "--action", "reassign", "--job-id", "RQ-9", "--lane", "dev",
    "--author", "router", "--reason", "retry after rejection"]));
  expect(slots.proposal).toMatchObject({ action: "set-slots", slots: 3, status: "proposed" });
  expect(reassigned.proposal).toMatchObject({ action: "reassign", job_id: "RQ-9", status: "proposed" });
  expect(readFileSync(join(root, "steer-proposals.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
    { action: "set-slots", lane: "dev", slots: 3, status: "applied" },
    { action: "reassign", job_id: "RQ-9", lane: "dev", status: "rejected" },
    slots.proposal, reassigned.proposal,
  ]);
});

test("only steer-proposals.jsonl is writable; slots.json and state files stay protected", () => {
  const root = fixture();
  for (const file of ["slots.json", "SLOTS.JSON", "targets.json", "holds.json", "jobs.jsonl",
    "intents.jsonl", "actions.jsonl", "leader-events.jsonl", "nested/../slots.json", "../steer-proposals.jsonl"]) {
    expect(() => reassign(root, ["--output", file])).toThrow();
    expect(() => steer(root, ["proposals", "--root", root, "--output", file])).toThrow();
  }
  expect(existsSync(join(root, "slots.json"))).toBe(false);
  reassign(root);
  expect(readFileSync(join(root, "jobs.jsonl"), "utf8")).toContain("RQ-1");
});

test("symlink and hardlink journals are refused without touching their targets", () => {
  const root = fixture(), target = join(root, "targets.json");
  const before = readFileSync(target, "utf8");
  for (const link of [symlinkSync, linkSync]) {
    const journal = join(root, "steer-proposals.jsonl");
    link(target, journal);
    expect(() => reassign(root)).toThrow();
    expect(() => steer(root, ["proposals"])).toThrow();
    expect(readFileSync(target, "utf8")).toBe(before);
    rmSync(journal);
  }
});

test("invalid arguments fail before appending", () => {
  const root = fixture();
  const bad = [
    [], ["oops"], ["propose"], ["lanes", "--output", "steer-proposals.jsonl"], ["read", "--root", root],
    ["propose", "--action", "pause", "--lane", "dev", "--author", "a", "--reason", "r"],
    ["propose", "--action", "reassign", "--job-id", "RQ-1", "--lane", "dev", "--slots", "2", "--author", "a", "--reason", "r"],
    ["propose", "--action", "set-slots", "--lane", "dev", "--slots", "2", "--job-id", "RQ-1", "--author", "a", "--reason", "r"],
    ["propose", "--action", "reassign", "--job-id", "RQ-1", "--lane", "dev", "--author", "a"],
    ["propose", "--action", "reassign", "--job-id", "RQ-1", "--lane", "dev", "--author", "a\nb", "--reason", "r"],
    ["propose", "--action", "reassign", "--job-id", "RQ-1", "--lane", "dev", "--author", "a", "--reason", " "],
    ["propose", "--action", "reassign", "--job-id", "RQ-1", "--lane", "dev", "--author", "a", "--reason", "r", "--lane", "ops"],
  ];
  for (const args of bad) expect(() => steer(root, args)).toThrow();
});

test("CLI emits parseable JSON and a nonzero JSON error on refusal", () => {
  const root = fixture(), script = join(import.meta.dir, "../scripts/fleet-steer.ts");
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, script, ...args]);
  const lanes = run("lanes", "--root", root);
  expect(lanes.exitCode).toBe(0);
  expect(JSON.parse(lanes.stdout.toString()).lanes.ops.jobs).toBe(2);
  const ok = run("propose", "--root", root, "--action", "set-slots", "--lane", "dev", "--slots", "6",
    "--author", "router", "--reason", "scale");
  expect(ok.exitCode).toBe(0);
  const dup = run("propose", "--root", root, "--action", "set-slots", "--lane", "dev", "--slots", "6",
    "--author", "router", "--reason", "scale");
  expect(dup.exitCode).toBe(1);
  expect(JSON.parse(dup.stderr.toString()).error).toContain("steer-proposals.jsonl");
  const refused = run("propose", "--root", root, "--action", "set-slots", "--lane", "dev", "--slots", "7",
    "--author", "router", "--reason", "scale", "--output", "slots.json");
  expect(refused.exitCode).toBe(1);
});
