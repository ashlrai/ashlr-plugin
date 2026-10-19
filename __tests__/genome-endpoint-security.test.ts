/**
 * Security regression: ashlr__genome_consolidate must never let the model
 * choose where $ASHLR_LLM_KEY or genome content is sent. `model` only opts in
 * to LLM merging; the endpoint comes from $ASHLR_LLM_URL under the gateway
 * rules.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initGenome } from "@ashlr/core-efficiency/genome";
import { getTool } from "../servers/_tool-base";
import "../servers/genome-server-handlers";
import { DEFAULT_GENOME_LLM_URL, handlePropose } from "../servers/genome-server";

const KEY = "sk-genome-canary-0123456789";

interface Capture { url: string; hits: Array<{ auth: string }>; stop: () => void }

function capture(redirectTo?: string): Capture {
  const hits: Capture["hits"] = [];
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      hits.push({ auth: req.headers.get("authorization") ?? "" });
      await req.text();
      if (redirectTo) return new Response(null, { status: 307, headers: { location: redirectTo } });
      const body = 'data: {"choices":[{"delta":{"content":"merged section"}}]}\n\ndata: [DONE]\n\n';
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${srv.port}/v1`, hits, stop: () => srv.stop(true) };
}

let project: string;
const servers: Capture[] = [];
const saved: Record<string, string | undefined> = {};
const VARS = ["ASHLR_LLM_URL", "ASHLR_LLM_KEY", "ASHLR_GATEWAY_STRICT"];

async function twoConflictingProposals(): Promise<void> {
  for (const content of ["Decision A: use bun.", "Decision B: use node."]) {
    await handlePropose({ section: "knowledge/decisions.md", content, operation: "update", rationale: "test", cwd: project });
  }
}

const consolidate = (args: Record<string, unknown>) => {
  const t = getTool("ashlr__genome_consolidate");
  if (!t) throw new Error("ashlr__genome_consolidate not registered");
  return t.handler({ cwd: project, ...args }, {} as never);
};

beforeEach(async () => {
  for (const v of VARS) saved[v] = process.env[v];
  project = mkdtempSync(join(tmpdir(), "ashlr-genome-sec-"));
  await initGenome(project, { project: "synthetic", vision: "test", milestone: "m1" });
  process.env.ASHLR_LLM_KEY = KEY;
  delete process.env.ASHLR_LLM_URL;
  delete process.env.ASHLR_GATEWAY_STRICT;
});

afterEach(() => {
  while (servers.length) servers.pop()!.stop();
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  rmSync(project, { recursive: true, force: true });
});

describe("ashlr__genome_consolidate endpoint comes from user config only", () => {
  test("a URL in `model` is never contacted; the key goes only to ASHLR_LLM_URL", async () => {
    const configured = capture();
    const attacker = capture();
    servers.push(configured, attacker);
    process.env.ASHLR_LLM_URL = configured.url;
    await twoConflictingProposals();
    await consolidate({ model: attacker.url });
    expect(attacker.hits).toEqual([]);
    expect(configured.hits.length).toBeGreaterThan(0);
    for (const h of configured.hits) expect(h.auth).toBe(`Bearer ${KEY}`);
  });

  test("with nothing configured, a URL in `model` still gets nothing", async () => {
    const attacker = capture();
    servers.push(attacker);
    await twoConflictingProposals();
    const res = await consolidate({ model: attacker.url });
    expect(attacker.hits).toEqual([]);
    expect(JSON.stringify(res)).toContain("consolidated");
  });

  test("model 'none' stays offline", async () => {
    const configured = capture();
    servers.push(configured);
    process.env.ASHLR_LLM_URL = configured.url;
    await twoConflictingProposals();
    await consolidate({ model: "none" });
    expect(configured.hits).toEqual([]);
  });

  test("a configured cross-origin redirect never carries the key", async () => {
    const target = capture();
    servers.push(target);
    const redirector = capture(`${target.url}/chat/completions`);
    servers.push(redirector);
    process.env.ASHLR_LLM_URL = redirector.url;
    await twoConflictingProposals();
    await consolidate({ model: "llm" });
    expect(redirector.hits.length).toBeGreaterThan(0);
    expect(target.hits).toEqual([]);
  });

  test("the schema no longer describes `model` as a URL, and the default is loopback by IP literal", () => {
    const t = getTool("ashlr__genome_consolidate")!;
    const desc = String((t.inputSchema as { properties: { model: { description: string } } }).properties.model.description);
    expect(desc).toContain("never used as an endpoint");
    expect(desc).not.toMatch(/https?:\/\//);
    expect(DEFAULT_GENOME_LLM_URL).toBe("http://127.0.0.1:1234/v1");
  });
});
