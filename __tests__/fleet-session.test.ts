import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetSession } from "../servers/fleet-session-server-handlers";
import { getTool } from "../servers/_tool-base";
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-session-"))); mkdirSync(join(root, "logs")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
test("latest job from full history, metrics, PR, worktree and exactly 150 trailing lines", () => {
  const job = { id: "RQ-1", metrics: { seconds: 42 }, pr_url: "https://github.com/org/repo/pull/1", worktree: "/tmp/wt" };
  writeFileSync(join(root, "jobs.jsonl"), [job, ...Array.from({length: 25}, (_, id) => ({id})), {...job, metrics: {seconds: 43}}].map(value => JSON.stringify(value)).join("\n"));
  writeFileSync(join(root, "logs/RQ-1.log"), Array.from({length: 160}, (_, i) => `line ${i}`).join("\n") + "\n");
  expect(fleetSession("RQ-1", root)).toMatchObject({metrics: {seconds: 43}, pr_url: job.pr_url, worktree: job.worktree, logs: Array.from({length: 150}, (_, i) => `line ${i + 10}`), errors: {}});
});
test("redacts credentials in logs and nested metadata while preserving JSON", () => {
  const secret = "ghp_" + "a".repeat(36);
  writeFileSync(join(root, "jobs.jsonl"), JSON.stringify({job_id: "RQ-1", metrics: {token: "fixture", detail: secret}}));
  writeFileSync(join(root, "logs/RQ-1.log"), `${secret}\nAuthorization: Bearer fixture\napi_key="fixture"\n${"Z".repeat(40)}`);
  const result = fleetSession("RQ-1", root);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain("fixture");
  expect(result.logs.every((line: string) => line.includes("[REDACTED]"))).toBe(true);
});
test("rejects traversal, absolute paths, encoded traversal and unexpected MCP arguments", async () => {
  for (const id of ["../outside", "/tmp/outside", "a/b", "a\\b", "%2e%2e", "..", "", "a\n", "a".repeat(129)]) {
    expect(() => fleetSession(id, root)).toThrow("invalid job_id");
    expect((await getTool("ashlr__fleet_session")!.handler({job_id: id}, {env: {}})).isError).toBe(true);
  }
  expect((await getTool("ashlr__fleet_session")!.handler({job_id: "RQ-1", path: root}, {env: {}})).isError).toBe(true);
});
test("missing logs preserve metadata; empty logs differ from missing; invalid jobs are unavailable", () => {
  writeFileSync(join(root, "jobs.jsonl"), '{"id":"RQ-1","metrics":{"seconds":2}}');
  expect(fleetSession("RQ-1", root)).toMatchObject({metrics: {seconds: 2}, logs: null, errors: {logs: "missing"}});
  writeFileSync(join(root, "logs/RQ-1.log"), "");
  expect(fleetSession("RQ-1", root).logs).toEqual([]);
  writeFileSync(join(root, "jobs.jsonl"), "malformed");
  expect(fleetSession("RQ-1", root)).toMatchObject({job: null, errors: {job: "invalid"}});
});
test("refuses symlink and hardlink logs and oversized files", () => {
  writeFileSync(join(root, "outside"), "private fixture");
  symlinkSync(join(root, "outside"), join(root, "logs/RQ-1.log"));
  linkSync(join(root, "outside"), join(root, "logs/RQ-2.log"));
  for (const id of ["RQ-1", "RQ-2"]) expect(fleetSession(id, root).errors.logs).toBe("unsafe");
  writeFileSync(join(root, "logs/RQ-3.log"), "x".repeat(4 * 1024 * 1024 + 1));
  expect(fleetSession("RQ-3", root).errors.logs).toBe("too_large");
});
test("rejects a symlinked log directory", () => {
  rmSync(join(root, "logs"), {recursive: true});
  mkdirSync(join(root, "elsewhere"));
  writeFileSync(join(root, "elsewhere/RQ-1.log"), "private fixture");
  symlinkSync(join(root, "elsewhere"), join(root, "logs"));
  expect(fleetSession("RQ-1", root).errors.logs).toBe("unsafe");
});
