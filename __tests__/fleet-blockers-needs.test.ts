import { afterEach, beforeEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetBlockers } from "../scripts/fleet-blockers";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const NEEDS = "supervisor/NEEDS-MASON.md", INBOX = "leader/MASON-INBOX.md";
let root: string;
const write = (name: string, text: string | Buffer) => writeFileSync(join(root, name), text);
const report = () => fleetBlockers(root, { now: () => NOW, procs: () => [], alive: () => false });
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-needs-")));
  for (const dir of ["supervisor", "leader", "queue/run", "metrics"]) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ["metrics/jobs.jsonl", "queue/dispatch-events.log", "router-events.log", "queue-author-codex.log", "ROUTER-QUEUE.md"]) write(file, "");
  write("queue/slots.json", "{}");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("three unresolved asks report exact fractional ages, repeats and newest inbox entry", () => {
  const needs = "# Needs Mason\n- [ ] [2026-10-30T09:00:00Z] Approve capacity (repeats=3)\n"
    + "- [ ] [2026-10-30T10:30:00Z] Review direction\n"
    + "- [ ] [2026-10-29T12:00:00Z] Choose provider (repeats=2)\n"
    + "- [x] [2026-10-28T12:00:00Z] Finished ask (repeats=9)\n"
    + "- [ ] [2026-10-30T11:00:00Z] Review direction\n";
  write(NEEDS, needs);
  write(INBOX, "## [2026-10-30T11:30:00Z] Latest\n## [2026-10-30T08:00:00Z] Older\n"
    + "Body mentions 2026-10-30T11:59:00Z, not an entry.\n");
  expect(report().human_needs).toEqual({ asks: [
    { ask: "Approve capacity", age_h: 3, repeat_count: 3 },
    { ask: "Review direction", age_h: 1.5, repeat_count: 2 },
    { ask: "Choose provider", age_h: 24, repeat_count: 2 },
  ], inbox_age_h: 0.5 });
  expect(report().errors).toEqual({});
  expect(readFileSync(join(root, NEEDS), "utf8")).toBe(needs);
});

test("missing and empty journals are optional and preserve a healthy report", () => {
  for (const present of [false, true]) {
    if (present) { write(NEEDS, ""); write(INBOX, "# Inbox\n"); }
    expect(report().human_needs).toEqual({ asks: [], inbox_age_h: null });
    expect(report().errors).toEqual({});
    expect(report().blockers).toEqual([]);
  }
});

test("invalid and future timestamps and invalid repeat counts stay unknown", () => {
  write(NEEDS, "- [ ] Undated ask\n- [ ] [2026-10-31T12:00:00Z] Future ask\n"
    + "- [ ] [2026-10-30T10:00:00Z] Invalid count (repeats=0)\n");
  write(INBOX, "- [2026-10-31T12:00:00Z] Future\n- [2026-10-30T09:00:00-02:00] Valid\n");
  expect(report().human_needs).toEqual({ asks: [
    { ask: "Undated ask", age_h: null, repeat_count: 1 },
    { ask: "Future ask", age_h: null, repeat_count: 1 },
    { ask: "Invalid count", age_h: 2, repeat_count: null },
  ], inbox_age_h: 1 });
  expect(report().errors).toEqual({ [NEEDS]: "invalid", [INBOX]: "invalid" });
  write(NEEDS, `- [ ] [2026-10-30T10:00:00Z] Overflow (repeats=${Number.MAX_SAFE_INTEGER})\n`
    + "- [ ] [2026-10-30T11:00:00Z] Overflow\n");
  expect(report().human_needs.asks).toEqual([{ ask: "Overflow", age_h: 2, repeat_count: null }]);
  expect(report().errors[NEEDS]).toBe("invalid");
});

test("journals reject symlink parents, hard links, oversized files and invalid UTF-8", () => {
  rmSync(join(root, "supervisor"), { recursive: true });
  symlinkSync(join(root, "leader"), join(root, "supervisor"));
  write("leader/NEEDS-MASON.md", "must not be read");
  expect(report().errors[NEEDS]).toBe("unsafe");
  linkSync(join(root, "leader/NEEDS-MASON.md"), join(root, INBOX));
  expect(report().errors[INBOX]).toBe("unsafe");
  rmSync(join(root, INBOX));
  write(INBOX, Buffer.alloc(4 * 1024 * 1024 + 1));
  expect(report().errors[INBOX]).toBe("too_large");
  write(INBOX, Buffer.from([0xff]));
  expect(report().errors[INBOX]).toBe("invalid_utf8");
});

test("ask text is redacted before truncation and CLI includes the needs section", () => {
  const credential = "fixture-value-that-must-stay-private";
  write(NEEDS, `- [ ] [${new Date(Date.now() - 3_600_000).toISOString()}] Resolve password=${credential} ${"word ".repeat(300)}\n`);
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/fleet-blockers.ts"), root],
    { env: { HOME: root, PATH: "/usr/bin:/bin" } });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).not.toContain(credential);
  const needs = JSON.parse(result.stdout.toString()).human_needs;
  expect(needs.asks[0].ask).toContain("password=[REDACTED]");
  expect(needs.asks[0].ask.length).toBe(1000);
});
