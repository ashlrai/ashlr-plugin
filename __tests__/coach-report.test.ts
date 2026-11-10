/**
 * Tests for scripts/coach-report.ts
 *
 * All tests use an isolated mkdtemp home; no real ~/.ashlr is touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { buildCoachReport } from "../scripts/coach-report";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let home: string;
let logPath: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-coach-report-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
  logPath = join(home, ".ashlr", "session-log.jsonl");
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const NOW = new Date("2025-06-01T12:00:00Z").getTime();

interface FakeRecord {
  ts?: string;
  agent?: string;
  event?: string;
  tool?: string;
  cwd?: string;
  session?: string;
  input_size?: number;
  output_size?: number;
}

function makeRecord(overrides: FakeRecord = {}): string {
  const base: FakeRecord = {
    ts: new Date(NOW - 60_000).toISOString(), // 1 min ago, within 7d window
    agent: "claude-code",
    event: "tool_call",
    tool: "ashlr__read",
    cwd: "/projects/foo",
    session: "sess-abc",
    input_size: 512,
    output_size: 1024,
  };
  return JSON.stringify({ ...base, ...overrides });
}

async function writeLog(records: string[]): Promise<void> {
  await writeFile(logPath, records.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Empty / missing log
// ---------------------------------------------------------------------------

describe("empty / missing log", () => {
  test("no log file → no obvious improvements", () => {
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toContain("No obvious improvements");
  });

  test("empty log file → no obvious improvements", async () => {
    await writeFile(logPath, "");
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toContain("No obvious improvements");
  });

  test("only blank lines → no obvious improvements", async () => {
    await writeFile(logPath, "\n\n   \n");
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toContain("No obvious improvements");
  });
});

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

describe("header", () => {
  test("shows day count and records scanned", async () => {
    await writeLog([makeRecord()]);
    const out = buildCoachReport({ home, now: NOW, days: 7 });
    expect(out).toContain("last 7 days");
    expect(out).toContain("records scanned: 1");
  });

  test("--days N reflected in header", async () => {
    await writeLog([makeRecord()]);
    const out = buildCoachReport({ home, now: NOW, days: 3 });
    expect(out).toContain("last 3 days");
  });

  test("footer always present", async () => {
    await writeLog([makeRecord()]);
    const out = buildCoachReport({ home, now: NOW });
    // /ashlr-usage was folded into /ashlr-dashboard --by-tool; no such command exists.
    expect(out).toContain("/ashlr-dashboard --by-tool");
    expect(out).not.toContain("/ashlr-usage");
    expect(out).toContain("/ashlr-savings");
  });
});

// ---------------------------------------------------------------------------
// Rule 1: Native Read on large files
// ---------------------------------------------------------------------------

describe("rule 1 — native Read on large files", () => {
  test("single large Read fires bullet", async () => {
    await writeLog([makeRecord({ tool: "Read", input_size: 3000 })]);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toMatch(/native Read.*large file/i);
    expect(out).toContain("ASHLR_ENFORCE=1");
  });

  test("small Read (<=2048) does not fire bullet", async () => {
    await writeLog([makeRecord({ tool: "Read", input_size: 2048 })]);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toContain("No obvious improvements");
  });

  test("token waste estimate is non-zero for large reads", async () => {
    // 3 large reads of 10000 bytes each → (3*10000)*0.6/4 = 4500 tokens
    const records = Array(3).fill(null).map(() =>
      makeRecord({ tool: "Read", input_size: 10_000 }),
    );
    await writeLog(records);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toMatch(/~\d+\.?\d*[KkM]?tok/);
    // Should mention 3 files
    expect(out).toContain("3 large files");
  });

  test("count is singular for exactly 1 file", async () => {
    await writeLog([makeRecord({ tool: "Read", input_size: 5000 })]);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toContain("1 large file —");
  });
});

// ---------------------------------------------------------------------------
// Rule 2: Native Grep
// ---------------------------------------------------------------------------

describe("rule 2 — native Grep", () => {
  test("single Grep fires bullet", async () => {
    await writeLog([makeRecord({ tool: "Grep" })]);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toMatch(/native Grep fired 1 time/i);
    expect(out).toContain("ashlr__grep averages 5x smaller");
  });

  test("multiple Grep calls shows count", async () => {
    const records = Array(5).fill(null).map(() => makeRecord({ tool: "Grep" }));
    await writeLog(records);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toContain("5 times");
  });

  test("ashlr__grep does not trigger this rule", async () => {
    await writeLog([makeRecord({ tool: "ashlr__grep" })]);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toContain("No obvious improvements");
  });
});

// ---------------------------------------------------------------------------
// Rule 3: Large Bash output
// ---------------------------------------------------------------------------

describe("rule 3 — large Bash output", () => {
  test("Bash with output > 16384 fires bullet", async () => {
    await writeLog([makeRecord({ tool: "Bash", output_size: 20_000 })]);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toMatch(/native Bash returned.*output/i);
    expect(out).toContain("ashlr__bash auto-compresses");
  });

  test("Bash with output <= 16384 does not fire", async () => {
    await writeLog([makeRecord({ tool: "Bash", output_size: 16_384 })]);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toContain("No obvious improvements");
  });

  test("count reflects number of oversized calls", async () => {
    const records = Array(3).fill(null).map(() =>
      makeRecord({ tool: "Bash", output_size: 30_000 }),
    );
    await writeLog(records);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toContain("3 times");
  });
});

// ---------------------------------------------------------------------------
// Rule 4: No genome but heavy ashlr__grep
// ---------------------------------------------------------------------------

describe("rule 4 — no genome with heavy ashlr__grep", () => {
  test("3+ ashlr__grep calls in project without genome fires bullet", async () => {
    // Use a temp dir as cwd that has no genome
    const fakeCwd = home; // definitely no .ashlrcode/ here
    const records = Array(4).fill(null).map(() =>
      makeRecord({ tool: "ashlr__grep", cwd: fakeCwd }),
    );
    await writeLog(records);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toContain("no genome");
    expect(out).toContain("/ashlr-genome-init");
  });

  test("fewer than 3 ashlr__grep calls — no bullet", async () => {
    const records = Array(2).fill(null).map(() =>
      makeRecord({ tool: "ashlr__grep", cwd: home }),
    );
    await writeLog(records);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toContain("No obvious improvements");
  });

  test("project with genome does not fire bullet", async () => {
    // Create a mock genome manifest
    const genomePath = join(home, ".ashlrcode", "genome");
    await mkdir(genomePath, { recursive: true });
    await writeFile(
      join(genomePath, "manifest.json"),
      JSON.stringify({ sections: [], updatedAt: "2025-01-01" }),
    );
    const records = Array(5).fill(null).map(() =>
      makeRecord({ tool: "ashlr__grep", cwd: home }),
    );
    await writeLog(records);
    const out = buildCoachReport({ home, now: NOW });
    // Genome exists — no bullet for missing genome
    expect(out).not.toContain("no genome");
  });
});

// ---------------------------------------------------------------------------
// Rule 5: Repeated reads of the same file
// ---------------------------------------------------------------------------

describe("rule 5 — repeated reads of same file", () => {
  test("3+ reads of same fingerprint (session+cwd+size) fires bullet", async () => {
    const records = Array(3).fill(null).map(() =>
      makeRecord({ tool: "Read", input_size: 4096, session: "sess-x", cwd: "/proj/bar" }),
    );
    await writeLog(records);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toContain("re-read 3 times");
    expect(out).toContain("mtime matches");
  });

  test("2 reads of same file — below threshold, no bullet", async () => {
    const records = Array(2).fill(null).map(() =>
      makeRecord({ tool: "ashlr__read", input_size: 4096, session: "sess-x" }),
    );
    await writeLog(records);
    const out = buildCoachReport({ home, now: NOW });
    // Rule 5 shouldn't fire with only 2
    expect(out).not.toContain("re-read");
  });

  test("different sessions don't aggregate for repeat-read count", async () => {
    // 3 reads of same file fingerprint but across 3 different sessions
    const records = ["s1", "s2", "s3"].map((sess) =>
      makeRecord({ tool: "Read", input_size: 4096, session: sess, cwd: "/proj/bar" }),
    );
    await writeLog(records);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).not.toContain("re-read 3 times");
  });
});

// ---------------------------------------------------------------------------
// Mixed: only triggered rules appear
// ---------------------------------------------------------------------------

describe("mixed records — only triggered rules fire", () => {
  test("only native Grep bullet when only Grep is present", async () => {
    const records = Array(3).fill(null).map(() => makeRecord({ tool: "Grep" }));
    await writeLog(records);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toContain("Native Grep");
    expect(out).not.toContain("native Read");
    expect(out).not.toContain("Native Bash");
  });

  test("all 5 rules fire together with synthetic 100-record log", async () => {
    const fakeCwd = home; // no genome
    const records: string[] = [
      // Rule 1: 5 large native Reads
      ...Array(5).fill(null).map(() =>
        makeRecord({ tool: "Read", input_size: 5000 }),
      ),
      // Rule 2: 4 native Greps
      ...Array(4).fill(null).map(() => makeRecord({ tool: "Grep" })),
      // Rule 3: 3 large Bash outputs
      ...Array(3).fill(null).map(() =>
        makeRecord({ tool: "Bash", output_size: 20_000 }),
      ),
      // Rule 4: 5 ashlr__grep calls in project without genome
      ...Array(5).fill(null).map(() =>
        makeRecord({ tool: "ashlr__grep", cwd: fakeCwd }),
      ),
      // Rule 5: 4 repeated reads of same file in one session
      ...Array(4).fill(null).map(() =>
        makeRecord({
          tool: "Read",
          input_size: 8192,
          session: "sess-repeat",
          cwd: "/proj/myapp",
        }),
      ),
      // Filler: ashlr__read records (not triggering anything)
      ...Array(79).fill(null).map(() => makeRecord({ tool: "ashlr__read" })),
    ];
    // Total > 100 lines; the 100-record variant described in spec
    await writeLog(records);
    const out = buildCoachReport({ home, now: NOW });
    expect(out).toMatch(/native Read.*large file/i);
    expect(out).toContain("Native Grep");
    expect(out).toMatch(/native Bash/i);
    expect(out).toContain("no genome");
    expect(out).toContain("re-read");
  });

  test("records scanned shows all records including those outside window", async () => {
    const oldTs = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
    const records = [
      makeRecord({ ts: oldTs }),       // outside 7d window
      makeRecord({ tool: "Grep" }),    // inside window
    ];
    await writeLog(records);
    const out = buildCoachReport({ home, now: NOW });
    // Both records are "scanned" (scanned = total parsed, filtered = window)
    expect(out).toContain("records scanned: 2");
  });
});

// ---------------------------------------------------------------------------
// Window handling: --days N
// ---------------------------------------------------------------------------

describe("--days N window handling", () => {
  test("records older than window do not trigger bullets", async () => {
    // 3 days ago — inside 7d but outside 1d
    const ts3d = new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString();
    const records = Array(3).fill(null).map(() =>
      makeRecord({ tool: "Grep", ts: ts3d }),
    );
    await writeLog(records);

    const out1d = buildCoachReport({ home, now: NOW, days: 1 });
    expect(out1d).toContain("No obvious improvements");

    const out7d = buildCoachReport({ home, now: NOW, days: 7 });
    expect(out7d).toContain("Native Grep");
  });

  test("--days 1 only catches records within last 24h", async () => {
    const ts12h = new Date(NOW - 12 * 60 * 60 * 1000).toISOString();
    const records = Array(4).fill(null).map(() =>
      makeRecord({ tool: "Grep", ts: ts12h }),
    );
    await writeLog(records);
    const out = buildCoachReport({ home, now: NOW, days: 1 });
    expect(out).toContain("Native Grep");
  });
});
