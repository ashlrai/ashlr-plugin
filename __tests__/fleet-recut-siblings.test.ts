import { expect, test } from "bun:test";
import { fleetRecutSiblings, siblingTarget, type Pull } from "../scripts/fleet-recut-siblings.ts";

const repo = "ashlrai/ashlr-plugin";
const pull = (number: number, title = "original", state = "open", merged_at: string | null = null): Pull =>
  ({ number, title, state, merged_at, html_url: `https://github.com/${repo}/pull/${number}` });
function fixture(pages: Pull[][], targets: Record<number, Pull> = {}) {
  const calls: string[][] = [];
  return { calls, deps: { gh: async (args: string[]) => {
    calls.push(args);
    expect(args.slice(0, 3)).toEqual(["api", "--method", "GET"]);
    expect(args.some(a => ["-f", "-F", "--field", "--input"].includes(a))).toBe(false);
    const path = args.at(-1)!;
    if (path === "repos/{owner}/{repo}") return JSON.stringify({ full_name: repo });
    if (path.endsWith("?state=closed&per_page=100")) {
      expect(args).toContain("--paginate"); expect(args).toContain("--slurp");
      return JSON.stringify(pages);
    }
    const target = targets[Number(path.split("/").at(-1))];
    if (!target) throw new Error("sensitive command output");
    return JSON.stringify(target);
  } } };
}
test("acceptance pairs span pages; already closed target 989 is separate; all calls GET", async () => {
  const f = fixture([
    [pull(1437, "RQ-DRAIN-ashlr-plugin-1036: recut", "closed", "2026-10-29")],
    [pull(973, "LAND-ashlr-plugin-926", "closed", "2026-10-28"),
      pull(1343, "LAND-RECUT-ashlr-plugin-989 repair", "closed", "2026-10-29")],
  ], { 1036: pull(1036), 926: pull(926), 989: pull(989, "original", "closed") });
  const result = (await fleetRecutSiblings([], f.deps)).repos[0]!;
  expect(result.closeList.map(p => [p.target.number, p.mergedSibling.number])).toEqual([[926, 973], [1036, 1437]]);
  expect(result.alreadyClosed.map(p => [p.target.number, p.mergedSibling.number])).toEqual([[989, 1343]]);
  expect(result.errors).toEqual([]);
});
test("matches only anchored identifiers for this repo with safe positive target numbers", () => {
  for (const title of ["prefix LAND-ashlr-plugin-1", "LAND-other-1", "LAND-ashlr-plugin-0",
    "LAND-ashlr-plugin-1x", "LAND-ashlr-plugin-9007199254740992", "LAND-ashlr-plugin-1-2"])
    expect(siblingTarget(title, repo)).toBeNull();
  expect(siblingTarget("LAND-RECUT-ASHLR-PLUGIN-12: fix", repo)).toBe(12);
});
test("ignores unmerged and self references; caches targets and sanitizes failures", async () => {
  const f = fixture([[pull(1, "LAND-ashlr-plugin-8", "closed"),
    pull(2, "LAND-ashlr-plugin-2", "closed", "date"),
    ...[3, 4].map(n => pull(n, "LAND-ashlr-plugin-8", "closed", "date")),
    ...[5, 6].map(n => pull(n, "LAND-ashlr-plugin-9", "closed", "date"))]], { 8: pull(8) });
  const report = await fleetRecutSiblings(["--repo", repo, "--repo", repo], f.deps);
  expect(report.repos).toHaveLength(1);
  expect(report.repos[0]!.closeList).toHaveLength(2);
  expect(report.repos[0]!.errors).toEqual([{ number: 9, stage: "target" }]);
  expect(f.calls).toHaveLength(3);
  expect(JSON.stringify(report)).not.toContain("sensitive");
});
test("invalid arguments fail before access; empty repos produce empty lists", async () => {
  const f = fixture([]);
  for (const args of [["--repo"], ["--repo", "../etc"], ["--write"], ["--repo", "a/b/c"]])
    await expect(fleetRecutSiblings(args, f.deps)).rejects.toThrow();
  expect(f.calls).toEqual([]);
  expect((await fleetRecutSiblings(["--repo", repo], f.deps)).repos[0]!.closeList).toEqual([]);
});
test("explicit repos isolate title matching and target lookups", async () => {
  const calls: string[][] = [];
  const report = await fleetRecutSiblings(["--repo", repo, "--repo", "ashlrai/phantom"], { gh: async args => {
    calls.push(args);
    expect(args.slice(0, 3)).toEqual(["api", "--method", "GET"]);
    const path = args.at(-1)!;
    const name = path.split("/")[2]!;
    if (path.includes("?")) return JSON.stringify([[
      pull(10, `LAND-${name}-8`, "closed", "date"),
      pull(11, `LAND-${name === "phantom" ? "ashlr-plugin" : "phantom"}-9`, "closed", "date"),
    ]]);
    expect(path).toBe(`repos/ashlrai/${name}/pulls/8`);
    return JSON.stringify(pull(8));
  } });
  expect(report.repos.map(r => [r.repo, r.closeList.length])).toEqual([[repo, 1], ["ashlrai/phantom", 1]]);
  expect(calls).toHaveLength(4);
});
