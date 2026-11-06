import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

const source = read("servers/_orchestrate-executor.ts");
const doc = read("docs/orchestrate-quota-follow-up.md");

describe("orchestrate-quota-follow-up.md records the source TODO", () => {
  test("quotes the executor's central Team quota TODO verbatim", () => {
    const todo = source.match(/TODO: [^\n]+/)?.[0];
    expect(todo).toBeDefined();
    expect(todo).toMatch(/central Team quota enforcement/);
    expect(doc).toContain(todo!);
  });

  test("is reachable from the docs index and the earlier follow-up note", () => {
    expect(read("docs/README.md")).toContain("orchestrate-quota-follow-up.md");
    expect(read("docs/orchestrate-team-quota-followup.md")).toContain(
      "orchestrate-quota-follow-up.md",
    );
  });
});

describe("orchestrate-quota-follow-up.md states the source's current behavior", () => {
  test("records which executor runs and under which flag", () => {
    expect(source).toContain("executeNodeStub");
    expect(source).toContain("STUB-NODE");
    expect(doc).toContain("executeNodeStub");
    expect(doc).toContain("STUB-NODE");
    expect(doc).toContain("ASHLR_ORCHESTRATE_REAL_LLM=1");
    expect(doc).toContain("executeNodeLlm");
  });

  test("records the no-credentials pre-flight without a network call", () => {
    expect(source).toContain("no LLM credentials configured");
    expect(source).toContain('provider.name === "none"');
    expect(doc).toContain("no LLM credentials configured");
    expect(doc).toMatch(/without making any\s+network call/);
  });

  test("records that Team shares Pro provider selection and gets no tier context", () => {
    expect(source).toMatch(/provider selection is currently the same as for Pro/);
    expect(source).toMatch(/receives no tier context/);
    expect(doc).toMatch(/same as for Pro/);
    expect(doc).toMatch(/no tier context/);
    expect(doc).toMatch(/does not enforce a shared\s+Team quota/);
  });

  test("records the per-node token cap exactly as the source computes it", () => {
    const cap = source.match(/HARD_TOKEN_CAP = ([\d_]+)/)?.[1]?.replace(/_/g, "");
    const mult = source.match(/TOKEN_CAP_MULTIPLIER = ([\d.]+)/)?.[1];
    expect(cap).toBeDefined();
    expect(mult).toBeDefined();
    expect(doc).toContain(
      `min(max(1, floor(estimatedTokens * ${mult})), ${cap})`,
    );
    expect(doc).toMatch(/missing estimate treated as zero/);
    expect(doc).toMatch(/may ignore `?maxTokens`?/);
  });

  test("records post-generation truncation and unchanged usage accounting", () => {
    const charsPerToken = source.match(/CHARS_PER_TOKEN = (\d+)/)?.[1];
    expect(charsPerToken).toBeDefined();
    expect(source).toContain("[truncated at cap]");
    expect(doc).toContain("[truncated at cap]");
    expect(doc).toMatch(/times the requested cap/);
    expect(doc).toContain(charsPerToken!);
    expect(doc).toMatch(/does not\s+limit tokens already generated or billed/);
    expect(doc).toMatch(/do not track or limit cumulative\s+usage/);
  });

  test("records that abort races the provider call without reaching it", () => {
    expect(source).toContain("Promise.race");
    expect(doc).toMatch(/raced against the provider call/);
    expect(doc).toMatch(/does not receive the\s+signal/);
  });
});
