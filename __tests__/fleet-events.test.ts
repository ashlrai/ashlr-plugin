import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, appendFileSync, rmSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetEvents } from "../servers/fleet-events-server-handlers";
import { getTool } from "../servers/_tool-base";
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-events-"))); mkdirSync(join(root, "metrics")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const write = (file: string, text: string) => writeFileSync(join(root, file), text);
test("parses typed JSON and dispatch text, omitting raw fields and malformed lines", () => {
  write("dispatch-events.log", '2026-10-29T12:00:00Z dispatched job=RQ-1\n{"event":"done","ts":"now","job":"RQ-2","secret":"fixture"}\nbroken\n');
  write("metrics/jobs.jsonl", '{"status":"completed","id":"RQ-3"}\n[]\n');
  const result = fleetEvents({}, root);
  expect(result.events).toEqual([
    { source: "dispatch-events.log", line: 1, type: "dispatched", timestamp: "2026-10-29T12:00:00Z", job_id: "RQ-1" },
    { source: "dispatch-events.log", line: 2, type: "done", timestamp: "now", job_id: "RQ-2" },
    { source: "metrics/jobs.jsonl", line: 1, type: "completed", timestamp: null, job_id: "RQ-3" },
  ]);
  expect(result.errors).toEqual({ "dispatch-events.log": "invalid", "metrics/jobs.jsonl": "invalid" });
  expect(JSON.stringify(result)).not.toContain("fixture");
});
test("caps pages at 200, resumes both sources, and supports polling appended lines", () => {
  write("dispatch-events.log", '{"event":"dispatch"}\n'.repeat(201));
  write("metrics/jobs.jsonl", '{"state":"done"}\n');
  const first = fleetEvents({}, root);
  expect(first.events).toHaveLength(200);
  expect(first.has_more).toBe(true);
  const second = fleetEvents({ cursor: first.cursor, limit: 1 }, root);
  expect(second.events[0]?.line).toBe(201);
  appendFileSync(join(root, "dispatch-events.log"), '{"event":"new"}\n');
  const third = fleetEvents({ cursor: second.cursor }, root);
  expect(third.events.map(e => e.type)).toEqual(["new", "done"]);
  expect(fleetEvents({ cursor: third.cursor }, root).events).toEqual([]);
});
test("missing files, partial appends, unsafe files and stale cursors are explicit", () => {
  expect(fleetEvents({}, root).errors).toEqual({ "dispatch-events.log": "missing", "metrics/jobs.jsonl": "missing" });
  write("dispatch-events.log", '{"event":"pending"}');
  expect(fleetEvents({}, root).events).toEqual([]);
  appendFileSync(join(root, "dispatch-events.log"), '\n');
  expect(fleetEvents({}, root).events).toHaveLength(1);
  expect(fleetEvents({ cursor: "v1:2:0" }, root).errors["dispatch-events.log"]).toBe("stale_cursor");
  symlinkSync(join(root, "dispatch-events.log"), join(root, "metrics/jobs.jsonl"));
  expect(fleetEvents({}, root).errors["metrics/jobs.jsonl"]).toBe("unsafe");
});
test("MCP rejects paths, invalid cursors and limits", async () => {
  for (const args of [{ path: ".env" }, { cursor: "bad" }, { cursor: null }, { limit: 201 }, { limit: 0 }, { limit: 1.5 }]) {
    expect((await getTool("ashlr__fleet_events")!.handler(args, { env: {} })).isError).toBe(true);
  }
});
test("rejects oversized logs, hard links and symlinked parents", () => {
  write("dispatch-events.log", " ".repeat(4 * 1024 * 1024 + 1));
  expect(fleetEvents({}, root).errors["dispatch-events.log"]).toBe("too_large");
  write("private", "sensitive-fixture");
  linkSync(join(root, "private"), join(root, "metrics/jobs.jsonl"));
  expect(fleetEvents({}, root).errors["metrics/jobs.jsonl"]).toBe("unsafe");
  symlinkSync(root, join(root, "alias"));
  expect(fleetEvents({}, join(root, "alias")).errors["dispatch-events.log"]).toBe("unsafe");
});
