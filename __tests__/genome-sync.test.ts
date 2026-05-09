/**
 * genome-sync.test.ts — Client-side genome sync tests.
 *
 * These run in the plugin root (bun test), not the server package.
 * Network calls are intercepted by replacing globalThis.fetch.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir, homedir } from "os";
import {
  generateKey,
  saveKey,
  serializeBlob,
  encryptSection,
  decryptSection,
  parseBlob,
} from "../servers/_genome-crypto.ts";

// ---------------------------------------------------------------------------
// Module reset helpers
// ---------------------------------------------------------------------------

// We import the sync module after setting env vars so the module picks them up.
// Bun resets module cache between test files, but within a file we control via
// dynamic import + env manipulation.

async function importSync() {
  // Force re-evaluation by appending a cache-busting query param is not
  // supported in Bun for local imports. Instead, we import once and rely on
  // the exported isTeamGenomeEnabled() guard which reads process.env at call time.
  return import("../servers/_genome-sync.ts");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ashlr-genome-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  // Restore env
  delete process.env["ASHLR_TEAM_GENOME_ID"];
  delete process.env["ASHLR_PRO_TOKEN"];
  // Restore fetch
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("genome-sync client", () => {
  // 1. With ASHLR_TEAM_GENOME_ID unset, no network calls fire
  it("does not call fetch when ASHLR_TEAM_GENOME_ID is unset", async () => {
    delete process.env["ASHLR_TEAM_GENOME_ID"];
    delete process.env["ASHLR_PRO_TOKEN"];

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const { pullTeamGenome, isTeamGenomeEnabled } = await importSync();
    expect(isTeamGenomeEnabled()).toBe(false);

    const result = await pullTeamGenome(join(tmpDir, "sections"));
    expect(result).toBeNull();
    expect(fetchCalled).toBe(false);
  });

  // 2. Pull applies remote sections to local filesystem
  it("pull writes remote sections to genomeSectionsDir", async () => {
    process.env["ASHLR_TEAM_GENOME_ID"] = "genome-abc";
    process.env["ASHLR_PRO_TOKEN"]      = "tok-test";
    process.env["ASHLR_GENOME_LOCAL_SEQ_PATH"] = join(tmpDir, "seq.json");

    const fakeSection = {
      path:        "sections/auth.md",
      content:     "# Auth\nTest content.",
      vclock:      { "client-a": 1 },
      conflictFlag: false,
      serverSeq:   1,
    };

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ sections: [fakeSection], serverSeqNum: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const { pullTeamGenome } = await importSync();
    const sectionsDir = join(tmpDir, "sections");
    const result = await pullTeamGenome(sectionsDir);

    expect(result).not.toBeNull();
    expect(result!.sections).toHaveLength(1);

    const written = await readFile(join(sectionsDir, "auth.md"), "utf-8");
    expect(written).toBe("# Auth\nTest content.");
  });

  // 3. Pull with empty sections list — no files written, no error
  it("pull with no new sections returns empty array and does not throw", async () => {
    process.env["ASHLR_TEAM_GENOME_ID"] = "genome-abc";
    process.env["ASHLR_PRO_TOKEN"]      = "tok-test";
    process.env["ASHLR_GENOME_LOCAL_SEQ_PATH"] = join(tmpDir, "seq.json");

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ sections: [], serverSeqNum: 5 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const { pullTeamGenome } = await importSync();
    const result = await pullTeamGenome(join(tmpDir, "sections"));
    expect(result!.sections).toHaveLength(0);
  });

  // 4. Push fires after an edit — fetch called with correct body shape
  it("pushTeamGenomeSection sends correct request body", async () => {
    process.env["ASHLR_TEAM_GENOME_ID"] = "genome-xyz";
    process.env["ASHLR_PRO_TOKEN"]      = "tok-test";

    let capturedBody: unknown = null;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ applied: ["sections/db.md"], conflicts: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { pushTeamGenomeSection } = await importSync();
    const result = await pushTeamGenomeSection("sections/db.md", "# DB\nContent.", { "client-a": 2 });

    expect(result).not.toBeNull();
    expect(result!.applied).toContain("sections/db.md");
    expect(result!.conflicts).toHaveLength(0);

    const body = capturedBody as { sections: { path: string; content: string; vclock: Record<string, number> }[] };
    expect(body.sections[0]!.path).toBe("sections/db.md");
    expect(body.sections[0]!.content).toBe("# DB\nContent.");
    expect(body.sections[0]!.vclock).toEqual({ "client-a": 2 });
  });

  // 5. Push returns null and does not throw on network error
  it("pushTeamGenomeSection returns null on fetch error", async () => {
    process.env["ASHLR_TEAM_GENOME_ID"] = "genome-xyz";
    process.env["ASHLR_PRO_TOKEN"]      = "tok-test";

    globalThis.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;

    const { pushTeamGenomeSection } = await importSync();
    const originalWrite = process.stderr.write;
    const writes: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = await pushTeamGenomeSection("sections/x.md", "content", { c: 1 });
      expect(result).toBeNull();
      expect(writes.join("")).toContain("network down");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  // 6. tickVClock increments client counter
  it("tickVClock increments the client entry", async () => {
    const { tickVClock } = await importSync();
    const base = { "client-a": 3, "client-b": 1 };
    const ticked = tickVClock(base, "client-a");
    expect(ticked["client-a"]).toBe(4);
    expect(ticked["client-b"]).toBe(1);
  });

  // 7. Encrypted push — fetch body contains ciphertext blob, not plaintext
  it("pushTeamGenomeSection encrypts content when a team key exists", async () => {
    const genomeId = `enc-push-test-${Date.now()}`;
    process.env["ASHLR_TEAM_GENOME_ID"] = genomeId;
    process.env["ASHLR_PRO_TOKEN"]      = "tok-test";

    const teamKey = generateKey();
    await saveKey(genomeId, teamKey);

    let capturedBody: { sections: { path: string; content: string }[] } | null = null;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ applied: ["sections/enc.md"], conflicts: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { pushTeamGenomeSection } = await importSync();
    const plaintext = "# Secret\nThis must not be sent in the clear.";
    await pushTeamGenomeSection("sections/enc.md", plaintext, { "c": 1 });

    const uploadedContent = capturedBody!.sections[0]!.content;
    // Should NOT be the original plaintext
    expect(uploadedContent).not.toBe(plaintext);
    // Should be a valid ciphertext blob that decrypts back to plaintext
    const blob = parseBlob(uploadedContent);
    expect(decryptSection(blob, teamKey)).toBe(plaintext);

    // Cleanup key file
    const { homedir } = await import("os");
    const { join } = await import("path");
    const { rm } = await import("fs/promises");
    await rm(join(homedir(), ".ashlr", "team-keys", `${genomeId}.key`), { force: true });
  });

  // 8. Encrypted pull — decrypts content_encrypted sections before writing to disk
  it("pullTeamGenome decrypts content_encrypted sections to disk", async () => {
    const genomeId = `enc-pull-test-${Date.now()}`;
    process.env["ASHLR_TEAM_GENOME_ID"] = genomeId;
    process.env["ASHLR_PRO_TOKEN"]      = "tok-test";
    process.env["ASHLR_GENOME_LOCAL_SEQ_PATH"] = join(tmpDir, "seq.json");

    const teamKey   = generateKey();
    await saveKey(genomeId, teamKey);

    const plaintext = "# DB\nEncrypted section content.";
    const blob      = encryptSection(plaintext, teamKey);
    const cipherStr = serializeBlob(blob);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        sections: [{
          path:              "sections/db.md",
          content:           cipherStr,
          content_encrypted: true,
          vclock:            { "c": 1 },
          conflictFlag:      false,
          serverSeq:         1,
        }],
        serverSeqNum: 1,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const { pullTeamGenome } = await importSync();
    const sectionsDir = join(tmpDir, "sections");
    await pullTeamGenome(sectionsDir);

    const written = await readFile(join(sectionsDir, "db.md"), "utf-8");
    expect(written).toBe(plaintext);

    // Cleanup key file
    const { homedir } = await import("os");
    const { join: j } = await import("path");
    const { rm } = await import("fs/promises");
    await rm(j(homedir(), ".ashlr", "team-keys", `${genomeId}.key`), { force: true });
  });

  // 9. Decryption failure — skip section without crashing, no file written
  it("pullTeamGenome skips section that fails to decrypt without crashing", async () => {
    const genomeId = `dec-fail-test-${Date.now()}`;
    process.env["ASHLR_TEAM_GENOME_ID"] = genomeId;
    process.env["ASHLR_PRO_TOKEN"]      = "tok-test";
    process.env["ASHLR_GENOME_LOCAL_SEQ_PATH"] = join(tmpDir, "seq.json");

    const rightKey = generateKey();
    const wrongKey = generateKey();
    await saveKey(genomeId, wrongKey); // wrong key on disk

    const blob      = encryptSection("secret content", rightKey); // encrypted with right key
    const cipherStr = serializeBlob(blob);

    let stderrOutput = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as NodeJS.WriteStream).write = ((chunk: unknown) => {
      stderrOutput += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        sections: [{
          path:              "sections/fail.md",
          content:           cipherStr,
          content_encrypted: true,
          vclock:            { "c": 1 },
          conflictFlag:      false,
          serverSeq:         1,
        }],
        serverSeqNum: 1,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const { pullTeamGenome } = await importSync();
    const sectionsDir = join(tmpDir, "sections");
    const result = await pullTeamGenome(sectionsDir);

    // Restore stderr
    (process.stderr as NodeJS.WriteStream).write = origWrite as typeof process.stderr.write;

    // Should not throw and should emit a warning
    expect(result).not.toBeNull();
    expect(stderrOutput).toMatch(/WARNING.*fail\.md.*failed to decrypt/);

    // File should NOT have been written
    const { existsSync } = await import("fs");
    expect(existsSync(join(sectionsDir, "fail.md"))).toBe(false);

    // Cleanup
    const { homedir } = await import("os");
    const { join: j } = await import("path");
    const { rm } = await import("fs/promises");
    await rm(j(homedir(), ".ashlr", "team-keys", `${genomeId}.key`), { force: true });
  });

  // 10. No key on disk — pull plaintext section normally (backward compat)
  it("pullTeamGenome writes plaintext section when no key file exists", async () => {
    process.env["ASHLR_TEAM_GENOME_ID"] = `no-key-genome-${Date.now()}`;
    process.env["ASHLR_PRO_TOKEN"]      = "tok-test";
    process.env["ASHLR_GENOME_LOCAL_SEQ_PATH"] = join(tmpDir, "seq.json");

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        sections: [{
          path:              "sections/plain.md",
          content:           "# Plain\nNo encryption here.",
          content_encrypted: false,
          vclock:            { "c": 1 },
          conflictFlag:      false,
          serverSeq:         1,
        }],
        serverSeqNum: 1,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const { pullTeamGenome } = await importSync();
    const sectionsDir = join(tmpDir, "sections2");
    await pullTeamGenome(sectionsDir);

    const written = await readFile(join(sectionsDir, "plain.md"), "utf-8");
    expect(written).toBe("# Plain\nNo encryption here.");
  });
});
