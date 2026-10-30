import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetDirtyTriage, type DirtyPull } from "../scripts/fleet-dirty-triage.ts";

const pr: DirtyPull = {
  number: 1, title: "Offline fixture", url: "https://example.invalid/pull/1", state: "OPEN",
  isDraft: false, isCrossRepository: false, autoMergeRequest: {}, mergeStateStatus: "DIRTY",
  headRefOid: "a".repeat(40), headRepository: { nameWithOwner: "ashlrai/locus" },
  baseRefName: "main", updatedAt: "2026-10-30T00:00:00Z",
};
const input = () => ({ repo: "ashlrai/locus", defaultBranch: "main",
  defaultFiles: { "src/a.ts": "first\nsecond\n" }, prs: [pr],
  addedLines: { "1": { "src/a.ts": ["first", "second"] } },
});
async function withFile(data: unknown, run: (path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "dirty-triage-"));
  try { const path = join(dir, "input.json"); writeFileSync(path, JSON.stringify(data)); await run(path); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const deps = { now: () => Date.parse("2026-10-30T12:00:00Z"),
  gh: async () => { throw new Error("Offline tests must never call GitHub"); } };

test.each([
  ["full", ["first", "second"], "already-on-default"],
  ["partial", ["first", "unique"], "recut-worthy"],
  ["none", ["unique"], "recut-worthy"],
  ["empty", [], "recut-worthy"],
  ["duplicates", ["first", "first"], "recut-worthy"],
  ["exact whitespace", [" first"], "recut-worthy"],
  ["no phantom trailing blank", [""], "recut-worthy"],
] as const)("%s added-line overlap", async (_, lines, classification) => {
  const data = input(); data.addedLines["1"]["src/a.ts"] = [...lines];
  await withFile(data, async path => {
    const report = await fleetDirtyTriage(["--input", path], deps);
    expect(report.counts.errors).toBe(0);
    expect(report.repos[0]!.prs[0]!.class).toBe(classification);
    expect(report.counts["already-on-default"]).toBe(classification === "already-on-default" ? 1 : 0);
  });
});

test("overlap is scoped to file and default branch; CRLF and duplicate occurrences work", async () => {
  for (const changes of [
    { defaultFiles: { "elsewhere.ts": "first\nsecond" } },
    { defaultBranch: "release" },
    { defaultFiles: { "src/a.ts": "" }, addedLines: { "1": { "src/a.ts": [""] } } },
  ]) await withFile({ ...input(), ...changes }, async path => {
    expect((await fleetDirtyTriage(["--input", path], deps)).repos[0]!.prs[0]!.class).toBe("recut-worthy");
  });
  await withFile({ ...input(), defaultFiles: { "src/a.ts": "first\r\nfirst\r\n" },
    addedLines: { "1": { "src/a.ts": ["first", "first"] } } }, async path => {
    expect((await fleetDirtyTriage(["--input", path], deps)).repos[0]!.prs[0]!.reason).toBe("C7");
  });
});

test("missing/malformed evidence is an input error, never a closable verdict or network fallback", async () => {
  for (const addedLines of [{}, { "1": null }, { "1": { "src/a.ts": [7] } }, { "1": { "src/a.ts": ["first\nsecond"] } }]) {
    await withFile({ ...input(), addedLines }, async path => {
      const report = await fleetDirtyTriage(["--input", path], deps);
      expect(report.repos[0]!.errors).toEqual([{ number: 1, stage: "input" }]);
      expect(report.repos[0]!.prs).toEqual([]);
      expect(report.counts.errors).toBe(1);
    });
  }
});

test("offline CLI filters, ranks, counts and rejects invalid input without Locus", async () => {
  await withFile({ ...input(), prs: [pr, { ...pr, number: 2, state: "CLOSED" },
    { ...pr, number: 3, mergeStateStatus: "CLEAN" }] }, async path => {
    const child = Bun.spawn([process.execPath, "scripts/fleet-dirty-triage.ts", "--input", path],
      { env: { ...process.env, PATH: "" }, stdout: "pipe", stderr: "pipe" });
    const report = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0);
    expect(report.repos[0]).toMatchObject({ scanned: 3, dirty: 1, prs: [{ class: "already-on-default", rank: 1 }] });
    await expect(fleetDirtyTriage(["--input", path, "--repo", "ashlrai/locus"], deps)).rejects.toThrow();
  });
  for (const data of [null, [], { ...input(), defaultFiles: null }, { ...input(), prs: [pr, pr] }])
    await withFile(data, async path => { await expect(fleetDirtyTriage(["--input", path], deps)).rejects.toThrow(); });
  for (const args of [["--input"], ["--input", "--stale-days", "7"], ["--input", "/missing", "--input", "/missing"]])
    await expect(fleetDirtyTriage(args, deps)).rejects.toThrow();
});
