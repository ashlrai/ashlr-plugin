import { expect, test } from "bun:test";
import { classify, fleetUpdateBehind, type Pull } from "../scripts/fleet-update-behind.ts";
const pull = (number = 1, extra: Partial<Pull> = {}): Pull => ({ number, state: "OPEN", isDraft: false,
  isCrossRepository: false, autoMergeRequest: {}, mergeStateStatus: "BEHIND", headRefOid: "a".repeat(40), ...extra });
function fixture(prs: Pull[], failures: string[] = [], current?: Pull) {
  const calls: string[][] = [], waits: number[] = [];
  return { calls, waits, deps: {
    gh: async (args: string[]) => {
      calls.push(args);
      if (args[1] === "list") return JSON.stringify(prs);
      if (args[1] === "view") return JSON.stringify(current ?? prs.find(p => p.number === Number(args[2])));
      const failure = failures.shift();
      if (failure) throw Object.assign(new Error("sensitive command output"), { stderr: failure });
      return "{}";
    },
    wait: async (ms: number) => { waits.push(ms); },
  } };
}
test("classification fails closed for ineligible and unknown states", () => {
  expect(classify(pull())).toBe("behind");
  expect(classify(pull(1, { mergeStateStatus: "DIRTY" }))).toBe("recut");
  for (const extra of [{ state: "CLOSED" }, { isDraft: true }, { isCrossRepository: true },
    { autoMergeRequest: null }, { mergeStateStatus: "UNKNOWN" }, { mergeStateStatus: "CLEAN" }, { mergeStateStatus: "BLOCKED" }]) {
    expect(classify(pull(1, extra))).toBe("skip");
  }
});
test("default dry-run caps selection and emits JSON recut candidates without mutations", async () => {
  const f = fixture([pull(4), pull(2), pull(1), pull(3), pull(5, { mergeStateStatus: "DIRTY" })]);
  const report = await fleetUpdateBehind([], f.deps);
  expect(JSON.parse(JSON.stringify(report))).toEqual({ dryRun: true, cap: 3, truncated: false,
    recutCandidates: [{ number: 5, headRefOid: "a".repeat(40) }],
    updates: [1, 2, 3].map(number => ({ number, status: "would-update", attempts: 0 })) });
  expect(f.calls).toHaveLength(1);
  expect(f.waits).toEqual([]);
});
test("apply enforces cap, rechecks eligibility and pins expected head", async () => {
  const f = fixture([pull(2), pull(1)]);
  const report = await fleetUpdateBehind(["--apply", "--cap", "1"], f.deps);
  expect(report.updates).toEqual([{ number: 1, status: "updated", attempts: 1 }]);
  expect(f.calls[1]?.slice(0, 3)).toEqual(["pr", "view", "1"]);
  expect(f.calls[2]).toEqual(["api", "--method", "PUT", "repos/{owner}/{repo}/pulls/1/update-branch", "-f", `expected_head_sha=${"a".repeat(40)}`]);
});
test("transient failures back off exponentially and retry", async () => {
  const f = fixture([pull()], ["HTTP 502", "HTTP 429"]);
  expect((await fleetUpdateBehind(["--apply"], f.deps)).updates[0]).toEqual({ number: 1, status: "updated", attempts: 3 });
  expect(f.waits).toEqual([1000, 2000]);
  expect(f.calls.filter(c => c[1] === "view")).toHaveLength(3);
});
test("exhausted and permanent failures are bounded, sanitized and consume cap", async () => {
  for (const failures of [["HTTP 503", "HTTP 503", "HTTP 503"], ["HTTP 422"], ["HTTP 403"]]) {
    const count = failures.length;
    const f = fixture([pull(), pull(2)], [...failures]);
    const report = await fleetUpdateBehind(["--apply", "--cap", "1"], f.deps);
    expect(report.updates).toEqual([{ number: 1, status: "failed", attempts: count }]);
    expect(f.waits).toHaveLength(count - 1);
    expect(JSON.stringify(report)).not.toContain("sensitive");
  }
});
test("changed eligibility or head and malformed heads prevent writes", async () => {
  for (const extra of [{ headRefOid: "b".repeat(40) }, { headRefOid: "bad" }, { autoMergeRequest: null }, { mergeStateStatus: "DIRTY" }]) {
    const f = fixture([pull()], [], pull(1, extra));
    expect((await fleetUpdateBehind(["--apply"], f.deps)).updates[0]?.status).toBe("changed");
    expect(f.calls.some(c => c[0] === "api")).toBe(false);
  }
});
test("invalid CLI arguments fail before discovery", async () => {
  const f = fixture([]);
  for (const args of [["--cap"], ["--cap", "0"], ["--cap", "101"], ["--cap", "1.5"], ["--unknown"]]) {
    await expect(fleetUpdateBehind(args, f.deps)).rejects.toThrow();
  }
  expect(f.calls).toEqual([]);
});
test("discovery failures propagate and full pages flag truncation", async () => {
  const f = fixture(Array.from({ length: 1000 }, (_, i) => pull(i + 1)));
  expect((await fleetUpdateBehind([], f.deps)).truncated).toBe(true);
  await expect(fleetUpdateBehind([], { ...f.deps, gh: async () => { throw new Error("discovery"); } })).rejects.toThrow("discovery");
});
test("a head change during backoff stops retries while other capped PRs proceed", async () => {
  const f = fixture([pull(), pull(2)], ["HTTP 502"]);
  const base = f.deps.gh;
  let views = 0;
  f.deps.gh = async args => args[1] === "view" && args[2] === "1" && ++views === 2
    ? JSON.stringify(pull(1, { headRefOid: "b".repeat(40) })) : base(args);
  expect((await fleetUpdateBehind(["--apply", "--cap", "2"], f.deps)).updates).toEqual([
    { number: 1, status: "changed", attempts: 1 }, { number: 2, status: "updated", attempts: 1 },
  ]);
  expect(f.waits).toEqual([1000]);
});
