/**
 * Regression: team-tier quota fallback in servers/_orchestrate-executor.ts.
 *
 * Documented behavior (see executeNodeLlm JSDoc and docs/orchestrate-quota-note.md):
 * Team uses the same provider selection as Pro, the executor gets no tier
 * context, and it enforces no shared/central Team quota. Only the per-node
 * maxTokens request and output truncation apply. Everything runs against a
 * fake provider; fetch is spied to prove no quota service is contacted.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  _setProviderFactoryForTests,
  executeNodeLlm,
} from "../servers/_orchestrate-executor";
import type { LlmProvider } from "../servers/_llm-providers/index";
import type { TaskNode } from "../servers/_task-graph";

function makeNode(id: string, estimatedTokens: number): TaskNode {
  return {
    id,
    agentKind: "refactorer",
    goal: `goal for ${id}`,
    scope: [`src/${id}.ts`],
    deps: [],
    estimatedTokens,
  };
}

let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new Error("network must not be used");
  }) as unknown as typeof fetch);
});

afterEach(() => {
  _setProviderFactoryForTests(null);
  fetchSpy.mockRestore();
});

describe("executeNodeLlm: Team quota fallback", () => {
  test("never contacts a quota service, even past the graph token budget", async () => {
    const maxTokensSeen: number[] = [];
    let totalOut = 0;
    const provider: LlmProvider = {
      name: "anthropic",
      async isAvailable() { return true; },
      async summarize(_t, _s, opts) {
        maxTokensSeen.push(opts?.maxTokens ?? -1);
        totalOut += 400;
        return { output: "ok", inTokens: 100, outTokens: 400, latencyMs: 0 };
      },
    };
    _setProviderFactoryForTests(async () => provider);

    // 10 nodes x 400 tokens out >> a 1000-token "team budget": nothing blocks.
    for (let i = 0; i < 10; i++) {
      const res = await executeNodeLlm({
        node: makeNode(`n${i}`, 100),
        handoffPayload: "",
        timeoutMs: 1000,
        // Extra tier context is ignored by the executor.
        ...({ tier: "team", teamTokenBudget: 1000 } as object),
      });
      expect(res.ok).toBe(true);
      expect(res.error).toBeUndefined();
    }
    expect(totalOut).toBe(4000);
    expect(maxTokensSeen).toEqual(Array(10).fill(150)); // floor(100 * 1.5)
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("only per-node limits apply: hard cap 5000 and output truncation", async () => {
    let requested = 0;
    const provider: LlmProvider = {
      name: "cloud",
      async isAvailable() { return true; },
      async summarize(_t, _s, opts) {
        requested = opts?.maxTokens ?? -1;
        // Provider ignores maxTokens and over-generates.
        return { output: "x".repeat(5000 * 4 + 50), inTokens: 1, outTokens: 9999, latencyMs: 0 };
      },
    };
    _setProviderFactoryForTests(async () => provider);

    const res = await executeNodeLlm({
      node: makeNode("big", 1_000_000),
      handoffPayload: "",
      timeoutMs: 1000,
    });
    expect(requested).toBe(5000);
    expect(res.ok).toBe(true);
    expect(res.output.endsWith("\n[truncated at cap]")).toBe(true);
    expect(res.output.length).toBe(5000 * 4 + "\n[truncated at cap]".length);
    // Reported usage is passed through untouched; nothing limits it.
    expect(res.tokensOut).toBe(9999);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("no credentials still fails before any network call", async () => {
    let called = false;
    _setProviderFactoryForTests(async () => ({
      name: "none",
      async isAvailable() { return false; },
      async summarize() { called = true; throw new Error("unreachable"); },
    }));
    const res = await executeNodeLlm({
      node: makeNode("n", 100),
      handoffPayload: "",
      timeoutMs: 1000,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no LLM credentials configured");
    expect(called).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
