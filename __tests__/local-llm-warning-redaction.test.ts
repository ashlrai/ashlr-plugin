/**
 * The once-per-process "local LLM unreachable" stderr warning names the
 * endpoint as scheme://host:port only. Credentials, path and query in
 * ASHLR_LLM_URL must never reach stderr. Runs in a subprocess because the
 * warning fires at most once per process.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const INDEX = resolve(import.meta.dir, "..", "servers", "_llm-providers", "index.ts");

async function warningFor(llmUrl: string): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "ashlr-warn-"));
  try {
    const script = `
      const { summarizeIfLarge } = await import(${JSON.stringify(INDEX)});
      await summarizeIfLarge("x".repeat(40000), { toolName: "ashlr__read", systemPrompt: "s", providerOverride: "local", timeoutMs: 1000 });
    `;
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, ASHLR_LLM_URL: llmUrl, ASHLR_LLM_KEY: "sk-warn-canary-0123456789" };
    const p = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
    const [err] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    return err;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("local LLM unreachable warning", () => {
  test("credentials, path and query in ASHLR_LLM_URL are not written to stderr", async () => {
    const err = await warningFor("http://alice:pw-canary-secret@127.0.0.1:1/v1/tenant-canary?token=q-canary-secret");
    expect(err).toContain("[ashlr] WARN: local LLM at http://127.0.0.1:1 unreachable");
    for (const leak of ["alice", "pw-canary-secret", "tenant-canary", "q-canary-secret", "sk-warn-canary"]) {
      expect(err).not.toContain(leak);
    }
  });

  test("a plain loopback URL is still named so a typo is easy to spot", async () => {
    const err = await warningFor("http://127.0.0.1:1/v1");
    expect(err).toContain("local LLM at http://127.0.0.1:1 unreachable");
  });
});
