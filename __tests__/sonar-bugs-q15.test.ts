import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLLMShim } from "../servers/genome-server";
import { syncCloudDeltas, type DeltaKind } from "../scripts/genome-cloud-sync";

test("S5850: orient keeps substring exclusions and anchors only the log suffix", () => {
  // Follow the Q13 ranker fixture: execute the actual function without spawning rg.
  const source = readFileSync(join(import.meta.dir, "../servers/orient-server.ts"), "utf8");
  const body = source.slice(source.indexOf("function grepCandidates("), source.indexOf("\nfunction fallbackFileSearch("));
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(body);
  const candidates = [
    "node_modules/auth.ts", "src/auth-node_modules.ts", "dist/auth.ts", "src/auth-dist.ts",
    "build/auth.ts", "src/auth-build.ts", "auth.lock.json", "auth.log", "src/auth.log/handler.ts",
    "src/auth.log.ts", "src/auth.ts", "src/catalog.ts",
  ];
  const rank = new Function("rgBinary", "spawnSync", "fallbackFileSearch", `${js}\nreturn grepCandidates;`)(
    () => "rg", () => ({ status: 0, stdout: candidates.join("\n") }), () => [],
  );
  expect(rank("/project", ["auth"], 20)).toEqual([
    "src/auth.log/handler.ts", "src/auth.log.ts", "src/auth.ts", "src/catalog.ts",
  ]);
});

test("S3923: genome shim concatenates text and ignores every non-text block", async () => {
  const previousUrl = process.env.ASHLR_LLM_URL;
  const previousKey = process.env.ASHLR_LLM_KEY;
  process.env.ASHLR_LLM_URL = "http://127.0.0.1:1234/v1";
  process.env.ASHLR_LLM_KEY = "";
  const requests: unknown[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
  }, { preconnect: fetch.preconnect }));
  try {
    const events = [];
    for await (const event of buildLLMShim()!.stream({
      systemPrompt: "system", tools: [], messages: [
        { role: "user", content: "plain" },
        { role: "assistant", content: [
          { type: "text", text: "first" },
          { type: "thinking", thinking: "private" },
          { type: "image_url", image_url: { url: "https://example.test/image" } },
          { type: "tool_use", id: "call", name: "tool", input: {} },
          { type: "tool_result", tool_use_id: "call", content: "result" },
          { type: "text", text: "" }, { type: "text", text: "last" },
        ] },
        { role: "tool", content: [{ type: "thinking", thinking: "private" }] },
        { role: "user", content: [] },
      ],
    })) events.push(event);
    expect(requests).toHaveLength(1);
    expect((requests[0] as { messages: unknown[] }).messages).toEqual([
      { role: "system", content: "system" }, { role: "user", content: "plain" },
      { role: "assistant", content: "firstlast" }, { role: "user", content: "" },
      { role: "user", content: "" },
    ]);
    expect(events).toEqual([{ type: "text_delta", text: "ok" }, { type: "message_end", stopReason: "end_turn" }]);
  } finally {
    fetchMock.mockRestore();
    if (previousUrl === undefined) delete process.env.ASHLR_LLM_URL;
    else process.env.ASHLR_LLM_URL = previousUrl;
    if (previousKey === undefined) delete process.env.ASHLR_LLM_KEY;
    else process.env.ASHLR_LLM_KEY = previousKey;
  }
});

describe.each([
  ["pr_merged", "prs"], ["issue_closed", "issues"],
] as const)("S6638: %s number selection", (kind: DeltaKind, subdir: string) => {
  let previousDisable: string | undefined;
  beforeEach(() => {
    previousDisable = process.env.ASHLR_CLOUD_GENOME_DISABLE;
    delete process.env.ASHLR_CLOUD_GENOME_DISABLE;
  });
  afterEach(() => {
    if (previousDisable === undefined) delete process.env.ASHLR_CLOUD_GENOME_DISABLE;
    else process.env.ASHLR_CLOUD_GENOME_DISABLE = previousDisable;
  });
  test.each([
    ["payload wins", 42, "99", "42"],
    ["zero payload wins", 0, "99", "0"],
    ["missing payload falls back", undefined, "99", "99"],
    ["null payload falls back", null, "99", "99"],
    ["empty source converts to zero", undefined, "", "0"],
    ["invalid source remains NaN", undefined, "invalid", "NaN"],
  ])("%s", async (_label, number, sourceSha, id) => {
    const cwd = mkdtempSync(join(tmpdir(), "sonar-q15-sync-"));
    try {
      mkdirSync(join(cwd, ".ashlrcode/genome"), { recursive: true });
      const result = await syncCloudDeltas({
        tier: "pro", cwd, home: cwd, genomeId: "q15", proToken: "test-only", apiUrl: "https://example.test",
        fetchFn: async () => Response.json({
          deltas: [{ id: 1, cursor: 1, kind, sourceSha, recordedAt: "2026-10-30T00:00:00Z", payload: { number } }],
          nextCursor: 1,
        }),
      });
      expect(result.written).toBe(1);
      const section = JSON.parse(readFileSync(join(cwd, ".ashlrcode/genome/sections", subdir, `${id}.json`), "utf8"));
      expect(section.id).toBe(id);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
