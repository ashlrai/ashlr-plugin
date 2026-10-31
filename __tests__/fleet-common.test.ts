import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  asRecord, defaultAshlrRoot, defaultFleetRoot, defaultRunsRoot, fleetCli, FLEET_MAX_BYTES,
  jobLane, jobLanes, parseFlagPairs, readBoundedFile, readFleetBuffer, readFleetText,
  safeFleetPath, writableJournal,
} from "../scripts/lib/fleet-common.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fleet-common-"));
  roots.push(root);
  mkdirSync(join(root, "metrics"), { recursive: true });
  writeFileSync(join(root, "metrics/jobs.jsonl"), '{"job_id":"RQ-1","pool":"dev"}\n');
  writeFileSync(join(root, "leaf.txt"), "leaf bytes\n");
  return root;
}

test("default roots are the fixed HOME-relative ashlr, fleet and runs directories", () => {
  expect(defaultAshlrRoot()).toBe(join(homedir(), ".ashlr"));
  expect(defaultFleetRoot()).toBe(join(homedir(), ".ashlr", "fleet"));
  expect(defaultRunsRoot()).toBe(join(homedir(), ".ashlr-runs"));
});

test("asRecord keeps only plain objects", () => {
  const value = { a: 1 };
  expect(asRecord(value)).toBe(value);
  for (const bad of [null, undefined, [], "x", 4, true]) expect(asRecord(bad)).toEqual({});
});

test("jobLane reads pool then lane then the unassigned bucket", () => {
  expect(jobLane({ pool: "dev", lane: "ops" })).toBe("dev");
  expect(jobLane({ lane: "ops" })).toBe("ops");
  expect(jobLane({})).toBe("unassigned");
  expect(jobLane({ pool: 5 })).toBe("5");
});

test("jobLanes decodes job_id or id rows with the last record winning", () => {
  const text = [
    JSON.stringify({ job_id: "RQ-1", pool: "dev" }),
    "",
    JSON.stringify({ id: "RQ-2", lane: "ops" }),
    JSON.stringify({ no_id: true }),
    JSON.stringify({ job_id: "RQ-1", lane: "ops" }),
  ].join("\n");
  expect([...jobLanes(text)]).toEqual([["RQ-1", "ops"], ["RQ-2", "ops"]]);
  expect(jobLanes("")).toEqual(new Map());
  expect(jobLanes('{"id":7,"pool":"dev"}').get("7")).toBe("dev");
  expect(() => jobLanes("not json")).toThrow();
});

test("parseFlagPairs returns allowlisted pairs in order", () => {
  const parsed = parseFlagPairs(["--root", "/x", "--lane", "dev"], ["--root", "--lane"], "USAGE");
  expect([...parsed.entries()]).toEqual([["--root", "/x"], ["--lane", "dev"]]);
  expect(parseFlagPairs([], ["--root"], "USAGE")).toEqual(new Map());
});

test("parseFlagPairs rejects unknown flags, duplicates, blank or missing values and strays", () => {
  for (const args of [
    ["--nope", "x"], ["--root", "a", "--root", "b"], ["--root", " "], ["--root"],
    ["stray", "--root", "x"], ["--root", "x", "--lane"],
  ]) expect(() => parseFlagPairs(args, ["--root", "--lane"], "USAGE")).toThrow("USAGE");
});

test("writableJournal resolves the fixed journal under root and refuses everything else", () => {
  const root = fixture();
  expect(writableJournal(root, "steer-proposals.jsonl", undefined, "PROTECTED"))
    .toBe(join(root, "steer-proposals.jsonl"));
  expect(writableJournal(root, "steer-proposals.jsonl", "steer-proposals.jsonl", "PROTECTED"))
    .toBe(join(root, "steer-proposals.jsonl"));
  for (const option of ["other.jsonl", "nested/steer-proposals.jsonl", "../steer-proposals.jsonl",
    join(root, "steer-proposals.jsonl") + "x", "/tmp/steer-proposals.jsonl"]) {
    expect(() => writableJournal(root, "steer-proposals.jsonl", option, "PROTECTED")).toThrow("PROTECTED");
  }
});

test("safeFleetPath returns the joined path for real files under real parents", () => {
  const root = fixture();
  const { path, stat } = safeFleetPath(root, "metrics/jobs.jsonl");
  expect(path).toBe(join(root, "metrics/jobs.jsonl"));
  expect(stat.isFile()).toBe(true);
});

test("safeFleetPath rejects traversal, absolute, backslash and empty names", () => {
  const root = fixture();
  for (const name of ["", "../leaf.txt", "metrics/../../leaf.txt", join(root, "leaf.txt"),
    "C:\\leaf.txt", "metrics\\jobs.jsonl", "metrics//jobs.jsonl", "./leaf.txt", "leaf\0.txt"]) {
    expect(() => safeFleetPath(root, name)).toThrow("unsafe");
  }
});

test("safeFleetPath rejects linked parents, linked files and hardlink aliases", () => {
  const root = fixture();
  symlinkSync(join(root, "metrics"), join(root, "linked"));
  expect(() => safeFleetPath(root, "linked/jobs.jsonl")).toThrow("unsafe");
  symlinkSync(join(root, "leaf.txt"), join(root, "link.txt"));
  expect(() => safeFleetPath(root, "link.txt")).toThrow("unsafe");
  linkSync(join(root, "leaf.txt"), join(root, "hard.txt"));
  expect(() => safeFleetPath(root, "hard.txt")).toThrow("unsafe");
});

test("safeFleetPath propagates ENOENT for missing roots and files, unsafe for non-directories", () => {
  const root = fixture();
  const code = (call: () => unknown) => { try { call(); } catch (error) { return (error as NodeJS.ErrnoException).code; } };
  expect(code(() => safeFleetPath(root, "missing.txt"))).toBe("ENOENT");
  expect(code(() => safeFleetPath(join(root, "missing-dir"), "leaf.txt"))).toBe("ENOENT");
  expect(() => safeFleetPath(join(root, "leaf.txt"), "x")).toThrow("unsafe");
  expect(() => safeFleetPath(root, "metrics")).toThrow("unsafe");
});

test("readFleetText reads nested files and readFleetBuffer shares the same checks", () => {
  const root = fixture();
  expect(readFleetText(root, "metrics/jobs.jsonl")).toBe('{"job_id":"RQ-1","pool":"dev"}\n');
  expect(readFleetBuffer(root, "leaf.txt").toString("utf8")).toBe("leaf bytes\n");
  expect(() => readFleetText(root, "metrics")).toThrow("unsafe");
});

test("readFleetText refuses oversized files at stat time and after a growing read", () => {
  const root = fixture();
  writeFileSync(join(root, "big.txt"), "x".repeat(17));
  expect(() => readFleetText(root, "big.txt", 16)).toThrow("too_large");
  expect(readFleetText(root, "big.txt", 17)).toBe("x".repeat(17));
  expect(readFleetText(root, "big.txt")).toBe("x".repeat(17));
  expect(FLEET_MAX_BYTES).toBe(4 * 1024 * 1024);
});

test("readBoundedFile caps a path already vetted by lstat", () => {
  const root = fixture();
  const { path, stat } = safeFleetPath(root, "leaf.txt");
  expect(readBoundedFile(path, stat).toString("utf8")).toBe("leaf bytes\n");
  expect(() => readBoundedFile(path, stat, 4)).toThrow("too_large");
});

test("fleetCli prints JSON results and reports failures to stderr", async () => {
  const out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (line: string) => out.push(line);
  console.error = (line: string) => err.push(line);
  try {
    expect(await fleetCli(() => ({ ok: true }), "ERR")).toEqual({ ok: true });
    expect(await fleetCli(() => { throw new Error(); }, "ERR")).toBeUndefined();
    expect(await fleetCli(async () => { throw new Error(); }, failure => `code:${(failure as Error).message || "x"}`)).toBeUndefined();
    expect(await fleetCli(() => { throw new Error(); }, { error: "E", usage: "U" })).toBeUndefined();
    expect(process.exitCode).toBe(1);
  } finally { console.log = log; console.error = error; process.exitCode = 0; }
  expect(out).toEqual(['{"ok":true}']);
  expect(err).toEqual(["ERR", "code:x", '{"error":"E","usage":"U"}']);
});
