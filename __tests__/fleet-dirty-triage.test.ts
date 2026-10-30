import { expect, test } from "bun:test";
import { fleetDirtyTriage, verdict, type Compare, type DirtyPull, type ReasonCode, type TriageClass }
  from "../scripts/fleet-dirty-triage.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const DAY = 86_400_000;
const BASE = "f".repeat(40);
const oid = (n: number) => n.toString(16).padStart(40, "0");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const pull = (number: number, extra: Partial<DirtyPull> = {}): DirtyPull => ({
  number, title: `PR ${number}`, url: `https://example.invalid/pull/${number}`,
  state: "OPEN", isDraft: false, isCrossRepository: false, autoMergeRequest: null,
  mergeStateStatus: "DIRTY", headRefOid: oid(number), headRepository: { nameWithOwner: "ashlrai/ashlr-plugin" },
  baseRefName: "main", baseRefOid: BASE, updatedAt: iso(1), ...extra,
});
const diverged = (ahead_by: number, behind_by: number): Compare => ({ status: "diverged", ahead_by, behind_by });

// Phantom fixture: 20 open PRs in ashlrai/ashlr-plugin. 14 are DIRTY and span
// every C1-C6 reason; 6 have other merge states and must be filtered out.
const PRS: DirtyPull[] = [
  pull(1), pull(2),                                            // C1: identical tree / fully contained
  pull(3), pull(4),                                            // C2: tip merged via sibling PRs
  pull(5, { autoMergeRequest: { enabledAt: iso(3) }, updatedAt: iso(40) }),
  pull(6, { autoMergeRequest: {} }), pull(7, { autoMergeRequest: {}, updatedAt: iso(0.25) }),
  pull(8), pull(9, { isCrossRepository: true, headRepository: { nameWithOwner: "contributor/ashlr-plugin" }, updatedAt: iso(13) }),
  pull(10, { isDraft: true, updatedAt: iso(2) }),              // C6: unique active patches
  pull(11, { updatedAt: iso(30) }), pull(12, { updatedAt: iso(14) }), // C4: cold, boundary inclusive
  pull(13, { headRepository: null }), pull(14, { headRefOid: "not-a-sha" }), // C3: heads gone
  pull(15, { mergeStateStatus: "CLEAN" }), pull(16, { mergeStateStatus: "BEHIND" }),
  pull(17, { mergeStateStatus: "BLOCKED" }), pull(18, { mergeStateStatus: "UNKNOWN" }),
  pull(19, { mergeStateStatus: "UNSTABLE" }), pull(20, { state: "CLOSED" }),
];
const COMPARES: Record<string, Compare> = {
  [oid(1)]: { status: "identical", ahead_by: 0, behind_by: 0 },
  [oid(2)]: { status: "behind", ahead_by: 0, behind_by: 9 },
  [oid(3)]: diverged(3, 7), [oid(4)]: diverged(2, 5), [oid(5)]: diverged(1, 12),
  [oid(6)]: diverged(4, 3), [oid(7)]: diverged(2, 1), [oid(8)]: diverged(5, 9),
  [oid(9)]: diverged(1, 2), [oid(10)]: diverged(3, 4), [oid(11)]: diverged(2, 8),
  [oid(12)]: diverged(1, 6),
};
const PULLS: Record<string, { number: number; merged_at: string | null }[]> = {
  [oid(3)]: [{ number: 301, merged_at: "2026-10-01T00:00:00Z" }],
  [oid(4)]: [{ number: 4, merged_at: null }, { number: 302, merged_at: "2026-10-02T00:00:00Z" }],
  [oid(5)]: [], [oid(6)]: [{ number: 6, merged_at: null }], [oid(7)]: [],
  [oid(8)]: [], [oid(9)]: [], [oid(10)]: [], [oid(11)]: [], [oid(12)]: [],
};

interface RepoData {
  prs: DirtyPull[]; compares?: Record<string, Compare>;
  pulls?: Record<string, { number: number; merged_at: string | null }[]>;
}
function fixture(data: Record<string, RepoData>, opts: {
  failCompare?: Record<string, string>; failPulls?: Record<string, string>;
  defaultRepo?: string;
} = {}) {
  const calls: string[][] = [];
  const defaultRepo = opts.defaultRepo ?? "ashlrai/ashlr-plugin";
  const repoOf = (path: string) => path.startsWith("repos/{owner}/{repo}") ? defaultRepo : path.split("/").slice(1, 3).join("/");
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      const repo = args.includes("--repo") ? args[args.indexOf("--repo") + 1]! : defaultRepo;
      return JSON.stringify(data[repo]?.prs ?? []);
    }
    if (args[0] === "api") {
      const path = args.find(a => a.startsWith("repos/"))!;
      if (path === "repos/{owner}/{repo}") return JSON.stringify({ full_name: defaultRepo });
      const repo = repoOf(path);
      if (path.includes("/compare/")) {
        const head = path.split("..")[1]!;
        if (opts.failCompare?.[head]) throw Object.assign(new Error("gh api failed"), { stderr: opts.failCompare[head] });
        const cmp = data[repo]?.compares?.[head];
        if (!cmp) throw Object.assign(new Error("gh api failed"), { stderr: "sensitive-404-body" });
        return JSON.stringify(cmp);
      }
      if (path.endsWith("/pulls")) {
        const sha = path.split("/")[4]!;
        if (opts.failPulls?.[sha]) throw Object.assign(new Error("gh api failed"), { stderr: opts.failPulls[sha] });
        return JSON.stringify(data[repo]?.pulls?.[sha] ?? []);
      }
    }
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  return { calls, deps: { gh, now: () => NOW } };
}
const expectReadOnly = (calls: string[][]) => {
  for (const c of calls) {
    expect(["pr", "api", "repo"]).toContain(c[0]);
    if (c[0] === "pr") expect(c[1]).toBe("list");
    if (c[0] === "api") {
      const m = c.indexOf("--method");
      expect(m === -1 || c[m + 1] === "GET").toBe(true);
      for (const a of c) expect(["-f", "-F", "--field", "--input"]).not.toContain(a);
      expect(c.some(a => a.startsWith("repos/"))).toBe(true);
    }
  }
};

test("20-PR fixture: only DIRTY ranked, all classes with C1-C6 reasons, strictly read-only", async () => {
  const f = fixture({ "ashlrai/ashlr-plugin": { prs: PRS, compares: COMPARES, pulls: PULLS } });
  const report = await fleetDirtyTriage([], f.deps);
  const repo = report.repos[0]!;
  expect(repo.repo).toBe("ashlrai/ashlr-plugin");
  expect(repo.scanned).toBe(20);
  expect(repo.dirty).toBe(14);
  expect(repo.errors).toEqual([]);
  expect(repo.counts).toEqual({ "recut-worthy": 6, superseded: 4, stale: 4 });
  expect(report.counts).toEqual({ "recut-worthy": 6, superseded: 4, stale: 4, errors: 0 });
  const want: Record<number, [TriageClass, ReasonCode]> = {
    1: ["superseded", "C1"], 2: ["superseded", "C1"], 3: ["superseded", "C2"], 4: ["superseded", "C2"],
    5: ["recut-worthy", "C5"], 6: ["recut-worthy", "C5"], 7: ["recut-worthy", "C5"],
    8: ["recut-worthy", "C6"], 9: ["recut-worthy", "C6"], 10: ["recut-worthy", "C6"],
    11: ["stale", "C4"], 12: ["stale", "C4"], 13: ["stale", "C3"], 14: ["stale", "C3"],
  };
  for (const [n, [cls, reason]] of Object.entries(want)) {
    const item = repo.prs.find(p => p.number === Number(n))!;
    expect([item.class, item.reason]).toEqual([cls, reason]);
  }
  expect(repo.prs.find(p => p.number === 3)?.detail).toContain("#301");
  expect(repo.prs.map(p => p.number)).toEqual([5, 6, 7, 8, 9, 10, 1, 2, 3, 4, 11, 12, 13, 14]);
  expect(repo.prs.map(p => p.rank)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  expectReadOnly(f.calls);
  expect(JSON.stringify(report)).not.toContain("sensitive");
});

test("C3 verdicts need no API calls and C1/C2 checks are skipped once base contains the patch", async () => {
  const f = fixture({ "ashlrai/ashlr-plugin": { prs: [pull(13, { headRepository: null }), pull(14, { headRefOid: "x" }), pull(1)], compares: COMPARES, pulls: {} } });
  const report = await fleetDirtyTriage([], f.deps);
  expect(report.repos[0]!.prs.map(p => [p.number, p.reason])).toEqual([[1, "C1"], [13, "C3"], [14, "C3"]]);
  expect(f.calls.filter(c => c[0] === "api")).toHaveLength(2); // repo resolve + one compare; never a pulls call
});

test("verdict precedence: head gone beats on-base, sibling beats automerge, boundary inclusive", () => {
  const ctx = { now: NOW, staleDays: 14, compare: { status: "identical" as const, ahead_by: 0 }, sibling: 301 };
  expect(verdict(pull(1, { headRepository: null }), ctx).reason).toBe("C3");
  expect(verdict(pull(1, { autoMergeRequest: {} }), ctx).reason).toBe("C1");
  expect(verdict(pull(3, { autoMergeRequest: {} }), { ...ctx, compare: diverged(3, 7) }).reason).toBe("C2");
  expect(verdict(pull(12, { updatedAt: iso(14) }), { ...ctx, compare: diverged(1, 6), sibling: null }).reason).toBe("C4");
  const inside = new Date(NOW - (14 * DAY - 1)).toISOString();
  expect(verdict(pull(8, { updatedAt: inside }), { ...ctx, compare: diverged(5, 9), sibling: null }).reason).toBe("C6");
  expect(verdict(pull(8, { updatedAt: "" }), { ...ctx, compare: diverged(5, 9), sibling: null }).reason).toBe("C6");
});

test("compare and pulls failures are bucketed per repo without leaking command output", async () => {
  const f = fixture({ "ashlrai/ashlr-plugin": { prs: [pull(8), pull(3)], compares: COMPARES, pulls: PULLS } },
    { failCompare: { [oid(8)]: "sensitive-token-compare" }, failPulls: { [oid(3)]: "sensitive-token-pulls" } });
  const report = await fleetDirtyTriage([], f.deps);
  const repo = report.repos[0]!;
  expect(repo.errors).toEqual([{ number: 8, stage: "compare" }, { number: 3, stage: "pulls" }]);
  expect(repo.prs).toEqual([]);
  expect(repo.counts).toEqual({ "recut-worthy": 0, superseded: 0, stale: 0 });
  expect(JSON.stringify(report)).not.toContain("sensitive");
  expectReadOnly(f.calls);
});

test("--repo groups rankings per repo without placeholder expansion", async () => {
  const f = fixture({
    "ashlrai/ashlr-plugin": { prs: [pull(1), pull(6, { autoMergeRequest: {} })], compares: COMPARES, pulls: PULLS },
    "ashlrai/phantom": { prs: [pull(21, { updatedAt: iso(60) })], compares: { [oid(21)]: diverged(2, 2) }, pulls: { [oid(21)]: [] } },
  });
  const report = await fleetDirtyTriage(["--repo", "ashlrai/phantom", "--repo", "ashlrai/ashlr-plugin"], f.deps);
  expect(report.repos.map(r => r.repo)).toEqual(["ashlrai/phantom", "ashlrai/ashlr-plugin"]);
  expect(report.repos[0]!.prs.map(p => [p.number, p.reason])).toEqual([[21, "C4"]]);
  expect(report.repos[1]!.prs.map(p => [p.number, p.reason])).toEqual([[6, "C5"], [1, "C1"]]);
  expect(f.calls.filter(c => c[0] === "pr").every(c => c.includes("--repo"))).toBe(true);
  expect(f.calls.some(c => c.includes("repos/{owner}/{repo}"))).toBe(false);
  expectReadOnly(f.calls);
});

test("invalid arguments and repo names fail before any discovery call", async () => {
  const f = fixture({});
  for (const args of [
    ["--bogus"], ["--repo"], ["--repo", "noslash"], ["--repo", "a/b/c"], ["--repo", "../etc"],
    ["--repo", "-bad/x"], ["--stale-days"], ["--stale-days", "0"], ["--stale-days", "366"], ["--stale-days", "1.5"],
  ]) await expect(fleetDirtyTriage(args, f.deps)).rejects.toThrow();
  expect(f.calls).toEqual([]);
});

test("a full page flags truncation; a custom stale-days window reclassifies cold PRs", async () => {
  const full = fixture({ "ashlrai/ashlr-plugin": { prs: Array.from({ length: 1000 }, (_, i) => pull(i + 1, { mergeStateStatus: "CLEAN" })) } });
  const capped = await fleetDirtyTriage([], full.deps);
  expect([capped.truncated, capped.repos[0]!.truncated, capped.repos[0]!.dirty]).toEqual([true, true, 0]);
  const f = fixture({ "ashlrai/ashlr-plugin": { prs: [pull(9, { updatedAt: iso(13) })], compares: COMPARES, pulls: PULLS } });
  expect((await fleetDirtyTriage(["--stale-days", "10"], f.deps)).repos[0]!.prs[0]!.reason).toBe("C4");
});
