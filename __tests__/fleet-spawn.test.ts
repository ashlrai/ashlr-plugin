import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetSpawn } from "../scripts/fleet-spawn.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-spawn-")));
  roots.push(root);
  mkdirSync(join(root, "mirrors", "ashlrai__ashlr-plugin"), { recursive: true });
  mkdirSync(join(root, "mirrors", "ashlrai__locus"), { recursive: true });
  mkdirSync(join(root, "mirrors", "other__locus"), { recursive: true });
  // A sibling-pins style link and a non-mirror entry never enroll a repo.
  symlinkSync(join(root, "mirrors", "ashlrai__locus"), join(root, "mirrors", "locus"));
  mkdirSync(join(root, "mirrors", "scratch"));
  writeFileSync(join(root, "targets.json"), JSON.stringify({ devin: 2 }));
  return root;
}
const now = new Date("2026-10-30T12:00:00Z");
const spawn = (root: string, args: string[]) => fleetSpawn(args, now, root);
const propose = (root: string, task = "triage the dirty pulls", extra: string[] = []) =>
  spawn(root, [task, "--repo", "ashlrai/ashlr-plugin", ...extra]);

test("a valid task appends an audited spawn proposal to the steer journal, never the queue", () => {
  const root = fixture(), output = join(root, "steer-proposals.jsonl");
  writeFileSync(output, '{"legacy":true}\nnot-json\n');
  const filed = propose(root);
  expect(filed.command).toBe("spawn");
  expect(filed.proposal).toMatchObject({
    schema_version: 1, action: "spawn", repo: "ashlrai/ashlr-plugin", task: "triage the dirty pulls",
    author: "fleet-spawn", proposed_at: "2026-10-30T12:00:00.000Z",
    observed: { mirror: "ashlrai__ashlr-plugin" }, status: "proposed",
  });
  expect(filed.proposal).not.toHaveProperty("reason");
  expect(filed.bytesAppended).toBe(Buffer.byteLength(JSON.stringify(filed.proposal) + "\n"));
  const lines = readFileSync(output, "utf8").split("\n");
  expect(lines[0]).toBe('{"legacy":true}');
  expect(lines.at(-2)).toBe(JSON.stringify(filed.proposal));
  // The task queue and fleet state files are never written.
  for (const file of ["tasks.json", "targets.json", "holds.json", "jobs.jsonl", "actions.jsonl", "intents.jsonl"]) {
    expect(existsSync(join(root, file))).toBe(file === "targets.json");
  }
  expect(readFileSync(join(root, "targets.json"), "utf8")).toBe('{"devin":2}');
});

test("author, reason and trimming are honored; multi-line detail survives as one JSON record", () => {
  const root = fixture();
  const filed = spawn(root, ["  add tests\n\tfor the parser  ", "--repo", "ashlrai/ashlr-plugin",
    "--author", "router", "--reason", "coverage gap"]);
  expect(filed.proposal).toMatchObject({
    action: "spawn", task: "add tests\n\tfor the parser", author: "router", reason: "coverage gap",
  });
  expect(readFileSync(join(root, "steer-proposals.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
});

test("bare repo names resolve to the unique enrolled mirror; ambiguity and misses refuse", () => {
  const root = fixture();
  const named = spawn(root, ["work on locus", "--repo", "ASHLR-Plugin"]);
  expect(named.proposal).toMatchObject({ repo: "ashlrai/ashlr-plugin", observed: { mirror: "ashlrai__ashlr-plugin" } });
  expect(() => spawn(root, ["more work", "--repo", "locus"])).toThrow("ambiguous fleet repo");
  for (const repo of ["acme/web", "nosuchrepo", "scratch", "../escape", "a/b/c", "-bad/x", "x".repeat(200)]) {
    expect(() => spawn(root, ["work", "--repo", repo])).toThrow();
  }
  // Only the one successful spawn was journaled; every refusal appended nothing.
  expect(readFileSync(join(root, "steer-proposals.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
});

test("an empty or malformed task is refused before any journal or directory is created", () => {
  const root = join(fixture(), "missing");
  for (const task of ["", "   ", "\t", "x".repeat(4001), "has\x00null", "bidi\u202eoverride"]) {
    expect(() => fleetSpawn([task, "--repo", "ashlrai/ashlr-plugin", "--root", root], now, root)).toThrow();
  }
  for (const args of [[], ["--repo", "ashlrai/ashlr-plugin"], ["task"], ["task", "--repo"],
    ["task", "--repo", "ashlrai/ashlr-plugin", "--slots", "2"], ["task", "--repo", "ashlrai/ashlr-plugin", "extra"],
    ["task", "--repo", "ashlrai/ashlr-plugin", "--repo", "ashlrai/locus"],
    ["task", "--repo", "ashlrai/ashlr-plugin", "--author", "a\nb"],
    ["task", "--repo", "ashlrai/ashlr-plugin", "--reason", "x".repeat(513)]]) {
    expect(() => fleetSpawn(args as string[], now, root)).toThrow();
  }
  expect(existsSync(root)).toBe(false);
});

test("an identical pending proposal is refused but a terminal one frees the slot", () => {
  const root = fixture();
  propose(root);
  expect(() => propose(root)).toThrow("duplicate proposal");
  expect(() => propose(root, "triage the dirty pulls", ["--author", "other", "--reason", "again"])).toThrow("duplicate proposal");
  expect(() => propose(root, "a different task")).not.toThrow();
  expect(() => spawn(root, ["triage the dirty pulls", "--repo", "ashlrai/locus", "--reason", "same task other repo"])).not.toThrow();
  writeFileSync(join(root, "steer-proposals.jsonl"),
    JSON.stringify({ action: "spawn", repo: "ashlrai/locus", task: "retried", status: "rejected" }) + "\n");
  expect(() => spawn(root, ["retried", "--repo", "ashlrai/locus", "--author", "router", "--reason", "retry"])).not.toThrow();
  // A steering proposal for the same lane never collides with spawn records.
  writeFileSync(join(root, "steer-proposals.jsonl"), JSON.stringify({ action: "reassign", job_id: "RQ-1", lane: "devin", status: "proposed" }) + "\n");
  expect(() => spawn(root, ["triage the dirty pulls", "--repo", "ashlrai/ashlr-plugin"])).not.toThrow();
});

test("symlink mirrors never enroll; only steer-proposals.jsonl is writable", () => {
  const root = fixture();
  rmSync(join(root, "mirrors", "ashlrai__locus"), { recursive: true });
  symlinkSync(join(root, "mirrors", "ashlrai__ashlr-plugin"), join(root, "mirrors", "linked__locus"));
  expect(() => spawn(root, ["work", "--repo", "linked/locus"])).toThrow("unknown fleet repo");
  for (const file of ["tasks.json", "TASKS.JSON", "targets.json", "holds.json", "jobs.jsonl",
    "actions.jsonl", "intents.jsonl", "nested/../tasks.json", "../steer-proposals.jsonl"]) {
    expect(() => propose(root, "work", ["--output", file])).toThrow();
  }
  expect(existsSync(join(root, "tasks.json"))).toBe(false);
  const journal = join(root, "steer-proposals.jsonl"), target = join(root, "targets.json");
  for (const link of [symlinkSync, linkSync]) {
    link(target, journal);
    expect(() => propose(root)).toThrow();
    expect(readFileSync(target, "utf8")).toBe('{"devin":2}');
    rmSync(journal);
  }
});

test("CLI emits parseable JSON and a nonzero JSON error on refusal", () => {
  const root = fixture(), script = join(import.meta.dir, "../scripts/fleet-spawn.ts");
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, script, ...args]);
  const ok = run("triage the dirty pulls", "--repo", "ashlrai/ashlr-plugin", "--root", root, "--reason", "backlog");
  expect(ok.exitCode).toBe(0);
  const out = JSON.parse(ok.stdout.toString());
  expect(out.command).toBe("spawn");
  expect(out.proposal).toMatchObject({ action: "spawn", repo: "ashlrai/ashlr-plugin", status: "proposed" });
  const dup = run("triage the dirty pulls", "--repo", "ashlrai/ashlr-plugin", "--root", root);
  expect(dup.exitCode).toBe(1);
  expect(JSON.parse(dup.stderr.toString()).error).toContain("steer-proposals.jsonl");
  const unknown = run("work", "--repo", "acme/web", "--root", root);
  expect(unknown.exitCode).toBe(1);
  const empty = run("   ", "--repo", "ashlrai/ashlr-plugin", "--root", root);
  expect(empty.exitCode).toBe(1);
});
