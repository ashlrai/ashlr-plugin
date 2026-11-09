import { afterEach, expect, test } from "bun:test";
import { runTaskGraph, _setIsTelemetryEnabledForTests } from "../scripts/orchestrate-run";
import { _setProviderFactoryForTests } from "../servers/_orchestrate-executor";
import type { TaskGraph, TaskNode } from "../servers/_task-graph";

const originalTier = process.env.ASHLR_TEST_TIER;
const originalLlm = process.env.ASHLR_ORCHESTRATE_REAL_LLM;

afterEach(() => {
  _setProviderFactoryForTests(null);
  _setIsTelemetryEnabledForTests(null);
  if (originalTier === undefined) delete process.env.ASHLR_TEST_TIER;
  else process.env.ASHLR_TEST_TIER = originalTier;
  if (originalLlm === undefined) delete process.env.ASHLR_ORCHESTRATE_REAL_LLM;
  else process.env.ASHLR_ORCHESTRATE_REAL_LLM = originalLlm;
});

function graph(count: number): TaskGraph {
  const nodes: TaskNode[] = Array.from({ length: count }, (_, i) => ({
    id: `node-${i}`, agentKind: "refactorer", goal: `goal ${i}`,
    scope: [`src/${i}.ts`], deps: [], estimatedTokens: 100,
  }));
  return {
    id: "team-boundary", goal: "boundary test", scope: "/tmp",
    tier: "team", createdAt: "2027-01-01T00:00:00.000Z", nodes,
    handoffs: [], metadata: { autoExpanded: true, totalTokenBudget: count * 100 },
  };
}

test("Team's 10-node boundary dispatches each node with its own token cap", async () => {
  process.env.ASHLR_TEST_TIER = "team";
  process.env.ASHLR_ORCHESTRATE_REAL_LLM = "1";
  _setIsTelemetryEnabledForTests(() => false);
  const requests: number[] = [];
  let totalOutputTokens = 0;
  _setProviderFactoryForTests(async () => ({
    name: "anthropic",
    async isAvailable() { return true; },
    async summarize(_text, _system, opts) {
      requests.push(opts?.maxTokens ?? -1);
      totalOutputTokens += 400;
      return { output: "ok", inTokens: 10, outTokens: 400, latencyMs: 0 };
    },
  }));

  const atLimit = await runTaskGraph({ graph: graph(10) });
  expect(atLimit.ok).toBe(true);
  expect(atLimit.nodeResults).toHaveLength(10);
  expect(atLimit.nodeResults.every((node) => node.ok && node.output === "ok")).toBe(true);
  expect(requests).toEqual(Array(10).fill(150));
  // Provider usage exceeds the graph's estimate; there is no shared token quota.
  expect(totalOutputTokens).toBe(4000);
  expect(totalOutputTokens).toBeGreaterThan(graph(10).metadata.totalTokenBudget);

  const overLimit = await runTaskGraph({ graph: graph(11) });
  expect(overLimit.ok).toBe(false);
  expect(overLimit.error).toBe("team-tier-10-agent-cap");
  expect(overLimit.nodeResults).toHaveLength(0);
  expect(requests).toHaveLength(10);
});
