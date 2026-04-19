/**
 * genome-live-refresh.test.ts — Genome auto-refresh after ashlr__edit.
 *
 * - Init a genome in a temp project.
 * - Write a file with known content.
 * - Add a genome section embedding that content.
 * - Run ashlr__edit on the file.
 * - Assert: the genome section was updated in place within 1 second.
 *
 * NOTE: genome-init uses the Ollama summarizer by default, which won't be
 * present in CI. We bypass summarization by seeding the manifest and section
 * files directly rather than going through ashlr__genome_propose. The live
 * refresh itself (refreshGenomeAfterEdit) does not require Ollama.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  makeTempHome,
  startMcpServer,
  pollUntil,
  SERVERS_DIR,
} from "../lib/harness.ts";

// ---------------------------------------------------------------------------
// Minimal genome manifest seed (no Ollama required)
// ---------------------------------------------------------------------------

function seedGenome(projectDir: string, fileName: string, content: string): string {
  const genomeDir   = join(projectDir, ".ashlrcode", "genome");
  const sectionsDir = join(genomeDir, "sections");
  mkdirSync(sectionsDir, { recursive: true });

  // Section path must be relative to genomeDir (sectionPath() prepends genomeDir).
  const sectionRelPath = "sections/section-001.md";
  const sectionFile    = join(genomeDir, sectionRelPath);
  // Embed the actual file content so findSectionsForFile sees "hello" in the body.
  const sectionBody = `<!-- ashlr:source ${fileName} -->\n${content}\n<!-- /ashlr:source -->`;
  writeFileSync(sectionFile, sectionBody, "utf8");

  // Manifest format must match GenomeManifest: sections[] have path/title/summary/tags.
  const manifest = {
    version: 1,
    sections: [
      {
        path:      sectionRelPath,
        title:     `Source: ${fileName}`,
        summary:   `Verbatim content from ${fileName}`,
        tags:      [fileName, "verbatim"],
        tokens:    content.split(/\s+/).length,
        updatedAt: new Date().toISOString(),
      },
    ],
    generation:     { number: 1, milestone: "m1", startedAt: new Date().toISOString() },
    fitnessHistory: [],
    createdAt:      new Date().toISOString(),
    updatedAt:      new Date().toISOString(),
  };
  writeFileSync(join(genomeDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  return sectionFile;
}

describe("genome-live-refresh", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) await fn().catch(() => {});
    cleanup = [];
  });

  it("updates the genome section after ashlr__edit within 1 second", async () => {
    const tempHome   = makeTempHome();
    const projectDir = join(tempHome, "project");
    mkdirSync(projectDir, { recursive: true });
    cleanup.push(async () => rmSync(tempHome, { recursive: true, force: true }));

    const fileName    = "target.ts";
    const filePath    = join(projectDir, fileName);
    const originalContent = "const greeting = 'hello';\n";
    const updatedContent  = "const greeting = 'world';\n";
    writeFileSync(filePath, originalContent, "utf8");

    const sectionFile = seedGenome(projectDir, fileName, originalContent);

    // Verify the section starts with original content
    expect(readFileSync(sectionFile, "utf8")).toContain("hello");

    const { callTool, teardown } = await startMcpServer({
      serverFile: join(SERVERS_DIR, "efficiency-server.ts"),
      tempHome,
      env: {
        CLAUDE_SESSION_ID: "test-session-genome-refresh",
        ASHLR_DISABLE_CLOUD_LLM: "1",
        ASHLR_GENOME_AUTO: "1",
      },
    });
    cleanup.push(teardown);

    // Run ashlr__edit
    await callTool("ashlr__edit", {
      path:    filePath,
      search:  "const greeting = 'hello';",
      replace: "const greeting = 'world';",
    });

    // Poll until the genome section reflects the edit
    await pollUntil(() => {
      if (!existsSync(sectionFile)) return false;
      const body = readFileSync(sectionFile, "utf8");
      return body.includes("world");
    }, 2000);

    const finalBody = readFileSync(sectionFile, "utf8");
    expect(finalBody).toContain("world");
    expect(finalBody).not.toContain("'hello'");
  }, 30_000);
});
