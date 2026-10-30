import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetIntent } from "../servers/fleet-intent-server-handlers";
import { getTool } from "../servers/_tool-base";
import { fleetSession } from "../servers/fleet-session-server-handlers";

describe("fleet intent", () => {
  let root: string;
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-intent-"))); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const audit = { requested_by: "router", reason: "operator request" };
  const requests = [
    { action: "pause", lane: "codex-personal" }, { action: "resume", lane: "codex-personal" },
    { action: "kill", job_id: "RQ-123" }, { action: "reassign", job_id: "RQ-123", lane: "devin" },
    { action: "set-slot", lane: "codex-personal", slots: 0 },
  ];
  test("all actions append audited pending records, preserving existing bytes and fleet state", () => {
    const prefix = '{"legacy":true}\n';
    writeFileSync(join(root, "intents.jsonl"), prefix);
    for (const file of ["targets.json", "holds.json", "jobs.jsonl", "leader-events.jsonl"]) writeFileSync(join(root, file), "unchanged");
    const records = requests.map(request => fleetIntent({ ...request, ...audit }, root));
    expect(readFileSync(join(root, "intents.jsonl"), "utf8")).toBe(prefix + records.map(record => JSON.stringify(record) + "\n").join(""));
    expect(new Set(records.map(record => record.id)).size).toBe(5);
    for (const record of records) {
      expect(record.status).toBe("pending");
      expect(record).toMatchObject(audit);
      expect(Number.isNaN(Date.parse(record.requested_at))).toBe(false);
    }
    for (const file of ["targets.json", "holds.json", "jobs.jsonl", "leader-events.jsonl"]) expect(readFileSync(join(root, file), "utf8")).toBe("unchanged");
  });
  test("invalid requests cannot create directories or append records", () => {
    const invalid = [null, [], {}, { action: "__proto__" }, ...requests.map(({ action }) => ({ action })),
      { ...requests[0], lane: "../secret" }, { ...requests[0], lane: "" }, { ...requests[0], job_id: "extra" },
      ...[-1, 1025, 1.5, "2", NaN, Infinity].map(slots => ({ ...requests[4], slots })),
      { ...requests[0], path: "/tmp/elsewhere" }, { ...requests[0], requested_by: " " },
      { ...requests[0], reason: "x".repeat(513) }, { action: "kill", job_id: "x\ny" },
    ];
    for (const request of invalid) {
      const value = request && !Array.isArray(request) ? { ...audit, ...request } : request;
      expect(() => fleetIntent(value, join(root, "missing"))).toThrow();
    }
    expect(existsSync(join(root, "missing"))).toBe(false);
    fleetIntent({ ...requests[0], ...audit }, root);
    const before = readFileSync(join(root, "intents.jsonl"), "utf8");
    expect(() => fleetIntent({ ...audit, action: "unknown" }, root)).toThrow();
    expect(readFileSync(join(root, "intents.jsonl"), "utf8")).toBe(before);
  });
  test("creates private log and escapes embedded newlines into one JSON line", () => {
    const dir = join(root, "new", "fleet");
    fleetIntent({ ...requests[4], ...audit, slots: 1024, reason: "first\nsecond" }, dir);
    expect(statSync(join(dir, "intents.jsonl")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "intents.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });
  test("rejects symlink parents, symlink logs, hard links and directories without changing targets", () => {
    writeFileSync(join(root, "target"), "unchanged");
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    expect(() => fleetIntent({ ...audit, ...requests[0] }, join(root, "alias"))).toThrow();
    for (const kind of ["symlink", "hardlink", "directory"]) {
      const path = join(root, "intents.jsonl");
      if (kind === "symlink") symlinkSync(join(root, "target"), path);
      else if (kind === "hardlink") linkSync(join(root, "target"), path);
      else mkdirSync(path);
      expect(() => fleetIntent({ ...audit, ...requests[0] }, root)).toThrow();
      expect(readFileSync(join(root, "target"), "utf8")).toBe("unchanged");
      rmSync(path, { recursive: true });
    }
  });
  test("registered handler rejects caller-selected paths and catalog advertises validation", async () => {
    const tool = getTool("ashlr__fleet_intent")!;
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
    expect((await tool.handler({ ...audit, ...requests[0], root }, { env: {} })).isError).toBe(true);
    const catalog = await Bun.file(join(import.meta.dir, "../servers/_tool-catalog.json")).json();
    expect(catalog.find((entry: { name: string }) => entry.name === tool.name)).toMatchObject({ inputSchema: tool.inputSchema, module: "./fleet-intent-server-handlers" });
  });
  test("MCP writes only the fixed HOME intent log and reports pending without executing", () => {
    const proc = Bun.spawnSync([process.execPath, "-e", `
      await import("./servers/fleet-intent-server-handlers.ts");
      const { getTool } = await import("./servers/_tool-base.ts");
      console.log(JSON.stringify(await getTool("ashlr__fleet_intent").handler(${JSON.stringify({ ...audit, ...requests[0] })}, { env: {} })));
    `], { cwd: join(import.meta.dir, ".."), env: { HOME: root, PATH: "/usr/bin:/bin" } });
    expect(proc.exitCode).toBe(0);
    const result = JSON.parse(proc.stdout.toString());
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(JSON.parse(readFileSync(join(root, ".ashlr/fleet/intents.jsonl"), "utf8")));
    expect(existsSync(join(root, ".ashlr/fleet/holds.json"))).toBe(false);
  });
});

describe("fleet session", () => {
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
});
