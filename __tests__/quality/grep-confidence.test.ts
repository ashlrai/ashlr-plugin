/**
 * Quality regression tests for the P2.1 genome-grep confidence signal.
 *
 * Tests the behaviour of ashlr__grep when genome returns sections alongside
 * the `rg estimates N total matches` confidence note injected at
 * servers/efficiency-server.ts ~L360-370.
 *
 * Strategy: drive the real MCP server over stdio (same pattern as
 * efficiency-server.test.ts) with a properly seeded genome (initGenome +
 * writeSection) and real source files on disk so `rg -c` can find actual
 * matches when the binary is available.
 *
 * NOTE: `estimateMatchCount` shells out to the rg binary. In environments
 * where rg is only a shell function (e.g. Claude Code's wrapped rg), the
 * binary won't be found and estimateMatchCount returns null — meaning the
 * `rg estimates` note is never emitted. rg-dependent assertions are guarded
 * with an `RG_AVAILABLE` check so they skip gracefully in that environment.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { existsSync } from "fs";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { initGenome, writeSection } from "@ashlr/core-efficiency/genome";

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

const INIT: RpcRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

/** True when a real rg binary (not a shell function) is accessible. */
const RG_AVAILABLE = ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"].some((p) =>
  existsSync(p),
);

async function rpcWithEnv(
  reqs: RpcRequest[],
  env: Record<string, string>,
  cwd?: string,
): Promise<Array<{ id: number; result?: any; error?: any }>> {
  const proc = spawn({
    cmd: ["bun", "run", join(import.meta.dir, "../../servers/efficiency-server.ts")],
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const responses: Array<{ id: number; result?: any; error?: any }> = [];

  async function waitFor(id: number) {
    while (true) {
      const existing = responses.find((r) => r.id === id);
      if (existing) return existing;
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream closed before id=${id}`);
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) responses.push(JSON.parse(line));
      }
    }
  }

  for (const r of reqs) {
    proc.stdin.write(JSON.stringify(r) + "\n");
    await waitFor(r.id);
  }
  await proc.stdin.end();
  await proc.exited;
  return responses;
}

/**
 * Build a project with a proper genome (initGenome + writeSection manifest entries)
 * and N source files each containing `pattern`. Returns the project directory.
 */
async function buildProject(opts: {
  pattern: string;
  fileCount: number;
  sectionCount?: number;
}): Promise<string> {
  const proj = await mkdtemp(join(tmpdir(), "ashlr-grep-conf-proj-"));
  await mkdir(join(proj, "src"), { recursive: true });

  await initGenome(proj, { project: "test", vision: "test vision", milestone: "m1" });

  const numSections = opts.sectionCount ?? 1;
  for (let s = 0; s < numSections; s++) {
    const relPath = `knowledge/section${s}.md`;
    const content = `# Section ${s}\n\nContains reference to ${opts.pattern} pattern.\n`;
    await writeSection(proj, relPath, content, {
      title: `Section ${s}`,
      summary: `Contains reference to ${opts.pattern} pattern.`,
      tags: [opts.pattern.toLowerCase().replace(/[^a-z0-9]/g, ""), "test"],
    });
  }

  for (let i = 0; i < opts.fileCount; i++) {
    await writeFile(
      join(proj, "src", `file${i}.ts`),
      `// file ${i}\nexport const x${i} = "${opts.pattern}";\n`,
    );
  }

  return proj;
}

let home: string;
const projects: string[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ashlr-grep-conf-home-"));
  await mkdir(join(home, ".ashlr"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  for (const p of projects.splice(0)) {
    await rm(p, { recursive: true, force: true }).catch(() => {});
  }
});

describe("grep confidence signal — genome header", () => {
  test("genome-routed grep returns the section count header", async () => {
    const pattern = "GREP_HEADER_CHECK_ALPHA";
    const proj = await buildProject({ pattern, fileCount: 1, sectionCount: 1 });
    projects.push(proj);

    const [, r] = await rpcWithEnv(
      [
        INIT,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "ashlr__grep", arguments: { pattern, cwd: proj } },
        },
      ],
      { HOME: home },
      proj,
    );
    const text: string = r.result.content[0].text;
    // Header must always include section count regardless of rg availability
    expect(text).toMatch(/\[ashlr__grep\] genome-retrieved \d+ section/);
  });

  test("no crash and returns a string when fileCount is 0", async () => {
    const pattern = "GREP_EMPTY_FILES_DELTA";
    const proj = await buildProject({ pattern, fileCount: 0, sectionCount: 1 });
    projects.push(proj);

    const [, r] = await rpcWithEnv(
      [
        INIT,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "ashlr__grep", arguments: { pattern, cwd: proj } },
        },
      ],
      { HOME: home },
      proj,
    );
    expect(r.result.isError).toBeFalsy();
    expect(typeof r.result.content[0].text).toBe("string");
    expect(r.result.content[0].text).not.toContain("bypassSummary:true");
  });

  test("multiple genome sections are all returned in the response", async () => {
    const pattern = "GREP_MULTI_SECTION_BETA";
    const proj = await buildProject({ pattern, fileCount: 1, sectionCount: 3 });
    projects.push(proj);

    const [, r] = await rpcWithEnv(
      [
        INIT,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "ashlr__grep", arguments: { pattern, cwd: proj } },
        },
      ],
      { HOME: home },
      proj,
    );
    const text: string = r.result.content[0].text;
    expect(text).toMatch(/genome-retrieved 3 section/);
  });
});

describe("grep confidence signal — rg estimates annotation (requires rg binary)", () => {
  test("output includes 'rg estimates' when rg binary is available", async () => {
    if (!RG_AVAILABLE) {
      console.log("  [skipped] rg binary not found at standard paths");
      return;
    }
    const pattern = "GREP_RG_AVAIL_ALPHA";
    const proj = await buildProject({ pattern, fileCount: 6, sectionCount: 1 });
    projects.push(proj);

    const [, r] = await rpcWithEnv(
      [
        INIT,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "ashlr__grep", arguments: { pattern, cwd: proj } },
        },
      ],
      { HOME: home },
      proj,
    );
    const text: string = r.result.content[0].text;
    expect(text).toMatch(/rg estimates \d+ total match/);
  });

  test("escalation note fires when rg count > sections * 4", async () => {
    if (!RG_AVAILABLE) {
      console.log("  [skipped] rg binary not found at standard paths");
      return;
    }
    // 1 section × 4 = 4. Use 6 files so rg count (6) > 4 → escalation.
    const pattern = "GREP_ESCALATE_BETA";
    const proj = await buildProject({ pattern, fileCount: 6, sectionCount: 1 });
    projects.push(proj);

    const [, r] = await rpcWithEnv(
      [
        INIT,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "ashlr__grep", arguments: { pattern, cwd: proj } },
        },
      ],
      { HOME: home },
      proj,
    );
    const text: string = r.result.content[0].text;
    expect(text).toContain("bypassSummary:true");
  });

  test("no escalation when rg count <= sections * 4", async () => {
    if (!RG_AVAILABLE) {
      console.log("  [skipped] rg binary not found at standard paths");
      return;
    }
    // 3 sections × 4 = 12. Only 1 source file → no escalation.
    const pattern = "GREP_NO_ESCALATE_GAMMA";
    const proj = await buildProject({ pattern, fileCount: 1, sectionCount: 3 });
    projects.push(proj);

    const [, r] = await rpcWithEnv(
      [
        INIT,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "ashlr__grep", arguments: { pattern, cwd: proj } },
        },
      ],
      { HOME: home },
      proj,
    );
    const text: string = r.result.content[0].text;
    // The escalation this test asserts ABSENT is the rg-count > sections×4
    // escalation line. The unrelated "confidence: medium · 1KB→0KB ·
    // bypassSummary:true recovers fidelity" hint fires whenever the output
    // is compressed at all, which is independent of escalation — match the
    // specific escalation phrase instead of a bare "bypassSummary:true".
    expect(text).not.toMatch(/rg saw \d+ matches.*bypassSummary:true/);
    expect(text).toMatch(/rg estimates \d+ total match/);
  });
});
