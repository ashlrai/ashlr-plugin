import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { windowsProcessEnv } from "../scripts/fleet-ghosts";
import { parseLedgerProfileOutput, profileLedgerWrites } from "../scripts/windows-ledger-profile";

function completed() {
  const root = mkdtempSync(join(tmpdir(), "ledger-profiler-child-test-")), path = join(root, "rows.jsonl");
  try {
    const child = spawnSync(process.execPath, [join(import.meta.dir, "../scripts/windows-ledger-profile.ts"), "--worker"], {
      env: { ...windowsProcessEnv(), PATH: process.env.PATH, HOME: root, USERPROFILE: root,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ASHLR_PROFILE_LEDGER: path, ASHLR_PROFILE_WRITER: "0" },
      encoding: "utf8", timeout: 5000, maxBuffer: 8192, windowsHide: true,
    });
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    const result = parseLedgerProfileOutput(child.stdout);
    const rows = readFileSync(path, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    expect(rows.length).toBe(80);
    expect(new Set(rows.map(row => `${row.hook}:${row.durationMs}`)).size).toBe(80);
    expect(result.metrics["ledger:fsyncSync"]?.calls).toBe(80);
    expect(result.metrics["lock-owner:fsyncSync"]?.calls).toBe(80);
    expect(result.metrics["lock-owner:renameSync"]?.calls).toBe(80);
    expect(result.metrics["lock-directory:rmSync"]?.calls).toBe(80);
    expect(JSON.stringify(result)).not.toContain(root);
    return child.stdout;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("passive wrappers preserve real 80-row output and every owner/append durability call", () => { completed(); });
test("synthetic metadata rejects missing, duplicate, foreign and non-finite observations", () => {
  const output = completed(), lines = output.trim().split(/\r?\n/), result = JSON.parse(lines.at(-1)!);
  const corrupt = (patch: Record<string, unknown>) => [...lines.slice(0, -1), JSON.stringify({ ...result, ...patch })].join("\n");
  for (const value of [output.slice(0, 10), output + output, output.replace('{"progress":8}', '{"progress":16}'),
    corrupt({ writer: 12 }), corrupt({ written: 79 }), corrupt({ appendMs: -1 }), corrupt({ retrySleepMs: null }),
    corrupt({ metrics: { "ledger:fsyncSync": { calls: 1, errors: 2, ms: 0 } } }),
    corrupt({ path: "FAKE_PRIVATE_TEST_PATH" }), corrupt({ metrics: {} }),
    corrupt({ metrics: { "foreign:path": { calls: 1, errors: 0, ms: 0 } } }),
    corrupt({ metrics: { "ledger:fsyncSync": { calls: 80, errors: 0, ms: null } } }),
    corrupt({ metrics: { "ledger:fsyncSync": { calls: 80, errors: 0, ms: 1, body: "FAKE_PRIVATE_TEST_VALUE" } } })]) {
    expect(() => parseLedgerProfileOutput(value)).toThrow();
  }
});


test("a partial native spawn failure reaps its already-owned children and removes its own temp root", async () => {
  const original = Bun.spawn;
  const children: ReturnType<typeof Bun.spawn>[] = [];
  let ownedRoot = "", calls = 0;
  const mocked = spyOn(Bun, "spawn").mockImplementation((...args: any[]) => {
    if (++calls === 3) throw new Error("controlled partial spawn failure");
    ownedRoot = dirname(dirname(args[0].env.ASHLR_PROFILE_LEDGER));
    const child = Reflect.apply(original, Bun, args);
    children.push(child); return child;
  });
  try { await expect(profileLedgerWrites()).rejects.toThrow("controlled partial spawn failure"); }
  finally { mocked.mockRestore(); }
  expect(children.length).toBe(2);
  expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  expect(existsSync(ownedRoot)).toBe(false);
});
