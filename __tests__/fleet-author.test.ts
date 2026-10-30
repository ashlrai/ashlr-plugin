import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetAuthor } from "../scripts/fleet-author.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const report = (queue: string) => fleetAuthor("", "", Buffer.from(queue), NOW);
const row = (state: string, start: number, char = "“") => `${state} `.padEnd(start, "x") + char + " end";

test("flags a split curly quote in READY and CLAIMED, with physical distance from tail", () => {
  const result = report(["# Queue", row("READY", 159), "", row("CLAIMED", 158), "DONE end", ""].join("\n"));
  expect(result.queue_status).toBe("split_utf8");
  expect(result.split_lines).toEqual([{ line: 2, lines_from_tail: 3 }, { line: 4, lines_from_tail: 1 }]);
});

test("clean fixture reports ok; complete characters, ASCII and inactive rows are safe", () => {
  for (const start of [0, 157, 160, 161]) expect(report(row("READY", start)).queue_status).toBe("ok");
  expect(report([row("READY", 159, "a"), row("CLAIMED", 159, "a"), row("DONE", 159), "ALREADY text", ""].join("\r\n"))
    .split_lines).toEqual([]);
  expect(report("").queue_status).toBe("ok");
});

test("checks byte offsets for multibyte prefixes, emoji and final lines without newline", () => {
  expect(report("| READY | " + "é".repeat(74) + "😀").split_lines).toEqual([{ line: 1, lines_from_tail: 0 }]);
  expect(report("\uFEFF" + row("READY", 156)).split_lines).toEqual([{ line: 1, lines_from_tail: 0 }]);
  expect(() => fleetAuthor("", "", Buffer.from([0xff]))).toThrow();
});

test("reports newest valid AUTOAUTHOR age and last error, redacting credentials", () => {
  const events = '[2026-10-30T10:00:00Z] AUTOAUTHOR done\n' +
    '{"event":"AUTOAUTHOR","ts":"2026-10-30T11:00:00Z"}\n' +
    '{"event":"AUTOAUTHOR","ts":"bad"}\n{"type":"AUTOAUTHOR","time":"2099-01-01T00:00:00Z"}\n' +
    '[2026-10-30T11:59:00Z] OTHER done\n';
  const result = fleetAuthor(events, "ERROR old\nERROR token=fixture-credential\nINFO end\n", Buffer.alloc(0), NOW);
  expect(result.last_autoauthor_age_s).toBe(3600);
  expect(result.last_codex_error).toBe("ERROR token=[REDACTED]");
  expect(fleetAuthor("", 'ERROR OPENAI_API_KEY=fixture-value GITHUB_TOKEN="fixture value"', Buffer.alloc(0)).last_codex_error)
    .toBe('ERROR OPENAI_API_KEY=[REDACTED] GITHUB_TOKEN=[REDACTED]');
  expect(report("").last_autoauthor_age_s).toBeNull();
  expect(report("").last_codex_error).toBeNull();
});

let home: string, dir: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "fleet-author-")); dir = join(home, ".ashlr-runs"); mkdirSync(dir); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const run = (args: string[] = []) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/fleet-author.ts"), ...args], {
  cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin" },
});
function fixture() {
  writeFileSync(join(dir, "router-events.log"), `[${new Date(Date.now() - 5000).toISOString()}] AUTOAUTHOR done\n`);
  writeFileSync(join(dir, "queue-author-codex.log"), "INFO done\n");
  writeFileSync(join(dir, "ROUTER-QUEUE.md"), row("READY", 157));
}

test("CLI reads fixed HOME paths, emits JSON and leaves all fixture bytes unchanged", () => {
  fixture();
  const before = readdirSync(dir).map(name => [name, readFileSync(join(dir, name)).toString("hex")]);
  const result = run(), output = JSON.parse(result.stdout.toString());
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(output).toMatchObject({ queue_status: "ok", errors: {}, split_lines: [] });
  expect(output.last_autoauthor_age_s).toBeGreaterThanOrEqual(5);
  expect(output.last_autoauthor_age_s).toBeLessThan(30);
  expect(readdirSync(dir).map(name => [name, readFileSync(join(dir, name)).toString("hex")])).toEqual(before);
  writeFileSync(join(dir, "ROUTER-QUEUE.md"), row("CLAIMED", 159));
  expect(JSON.parse(run().stdout.toString()).split_lines).toEqual([{ line: 1, lines_from_tail: 0 }]);
});

test("missing, malformed and symlinked inputs are explicit unknowns", () => {
  const missing = run();
  expect(missing.exitCode).toBe(1);
  expect(JSON.parse(missing.stdout.toString())).toMatchObject({ queue_status: "unknown", errors: { events: "ENOENT", codex: "ENOENT", queue: "ENOENT" } });
  fixture();
  writeFileSync(join(dir, "ROUTER-QUEUE.md"), Buffer.from([0xff]));
  expect(JSON.parse(run().stdout.toString()).errors.queue).toBe("invalid_utf8");
  rmSync(join(dir, "ROUTER-QUEUE.md"));
  symlinkSync(join(dir, "router-events.log"), join(dir, "ROUTER-QUEUE.md"));
  expect(JSON.parse(run().stdout.toString()).queue_status).toBe("unknown");
});

test("CLI rejects positional paths and flags without echoing arguments", () => {
  for (const args of [["arbitrary-path"], ["--input", "arbitrary-path"], ["--help"]]) {
    const result = run(args);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString()).error).toContain("no arguments");
    expect(result.stdout.toString()).not.toContain("arbitrary-path");
  }
});
