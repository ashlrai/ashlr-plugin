/**
 * fleet-journal.test.ts — tests for the bounded, link-resistant JSONL reader.
 *
 * scripts/fleet-journal.ts backs every fleet controller read of request
 * journals (spawn, steer, controller). A hostile or corrupted journal must
 * fail loudly ("unsafe" / "too large") rather than feed the controller
 * half-parsed state, and non-object lines must be counted, not dropped
 * silently. None of that was pinned anywhere.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOURNAL_MAX_BYTES, readJournal, TERMINAL_STATUSES } from "../scripts/fleet-journal.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function journal(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ashlr-fleet-journal-"));
  dirs.push(dir);
  const path = join(dir, "journal.jsonl");
  writeFileSync(path, body);
  return path;
}

describe("readJournal", () => {
  test("a missing journal reads as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "ashlr-fleet-journal-"));
    dirs.push(dir);
    expect(readJournal(join(dir, "absent.jsonl"))).toEqual({ entries: [], skipped: 0 });
  });

  test("parses object records with 1-based physical line numbers", () => {
    const path = journal('{ "id": 1 }\n\nnot json\n{ "id": 2 }\n');
    const read = readJournal(path);
    expect(read.entries).toEqual([
      { record: { id: 1 }, line: 1 },
      { record: { id: 2 }, line: 4 },
    ]);
    expect(read.skipped).toBe(1);
  });

  test("counts non-object JSON lines as skipped, including arrays and null", () => {
    const path = journal('[1, 2]\n"scalar"\nnull\n{ "ok": true }\n');
    const read = readJournal(path);
    expect(read.entries).toHaveLength(1);
    expect(read.skipped).toBe(3);
  });

  test("blank trailing lines are neither entries nor skipped", () => {
    const path = journal('{ "id": 1 }\n\n\n');
    expect(readJournal(path)).toEqual({ entries: [{ record: { id: 1 }, line: 1 }], skipped: 0 });
  });

  test("a symlinked journal is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "ashlr-fleet-journal-"));
    dirs.push(dir);
    const real = join(dir, "real.jsonl");
    const link = join(dir, "link.jsonl");
    writeFileSync(real, '{ "id": 1 }\n');
    symlinkSync(real, link);
    expect(() => readJournal(link)).toThrow("unsafe fleet journal");
  });

  test("a hardlinked journal is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "ashlr-fleet-journal-"));
    dirs.push(dir);
    const real = join(dir, "real.jsonl");
    const alias = join(dir, "alias.jsonl");
    writeFileSync(real, '{ "id": 1 }\n');
    linkSync(real, alias);
    expect(() => readJournal(alias)).toThrow("unsafe fleet journal");
  });

  test("an oversized journal is refused, not truncated", () => {
    const path = journal('{ "id": 1 }\n' + "x".repeat(JOURNAL_MAX_BYTES));
    expect(() => readJournal(path)).toThrow("fleet journal too large");
  });
});

describe("TERMINAL_STATUSES", () => {
  test("only review-releasing statuses are terminal", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["applied", "rejected", "superseded", "withdrawn"]);
    for (const stillAwaiting of ["proposed", "review", "queued"]) {
      expect(TERMINAL_STATUSES.has(stillAwaiting)).toBe(false);
    }
  });
});
