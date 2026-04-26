/**
 * write-tool.test.ts — ashlr__write tool unit tests.
 *
 * Covers:
 *   - New file: compact ack returned (path, bytes, sha8). Content NOT echoed.
 *   - New file: file actually written to disk.
 *   - Existing file: delegates to ashlrEdit. Returns diff-format text.
 *   - Existing file: file content updated on disk.
 *   - sha8 matches first 8 chars of sha256(content).
 *   - Outside-cwd path is rejected.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { realpathSync } from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { join } from "path";

import {
  ashlrWrite,
  formatWriteResult,
  type WriteResult,
} from "../servers/write-server";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
const ORIGINAL_CWD = process.cwd();

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ashlr-write-"));
  process.chdir(tmpDir);
});

afterEach(async () => {
  if (process.cwd() !== ORIGINAL_CWD) {
    try { process.chdir(ORIGINAL_CWD); } catch { /* ignore */ }
  }
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// New file
// ---------------------------------------------------------------------------

describe("ashlr__write · new file", () => {
  test("returns compact ack without echoing content", async () => {
    const filePath = join(tmpDir, "new-file.ts");
    const content = "export const x = 42;\n";

    const result = await ashlrWrite({ filePath, content });

    expect(result.kind).toBe("new");
    if (result.kind !== "new") throw new Error("expected new");

    // Ack fields present. Compare canonicalized paths — macOS /var → /private/var symlink.
    expect(result.ack.created).toBe(realpathSync(filePath));
    expect(result.ack.bytes).toBe(content.length);
    expect(result.ack.sha8).toHaveLength(8);

    // Content NOT in the ack.
    expect(JSON.stringify(result.ack)).not.toContain("export const");
  });

  test("sha8 matches first 8 chars of sha256(content)", async () => {
    const filePath = join(tmpDir, "hash-check.ts");
    const content = "const hello = 'world';\n";

    const result = await ashlrWrite({ filePath, content });
    if (result.kind !== "new") throw new Error("expected new");

    const expected = createHash("sha256").update(content).digest("hex").slice(0, 8);
    expect(result.ack.sha8).toBe(expected);
  });

  test("file is actually written to disk", async () => {
    const filePath = join(tmpDir, "written.ts");
    const content = "const value = 123;\n";

    await ashlrWrite({ filePath, content });

    const onDisk = await readFile(filePath, "utf-8");
    expect(onDisk).toBe(content);
  });

  test("formatWriteResult for new file includes path and bytes", async () => {
    const filePath = join(tmpDir, "fmt-test.ts");
    const content = "// hello\n";

    const result = await ashlrWrite({ filePath, content });
    const text = formatWriteResult(result);

    expect(text).toContain("created");
    // Path in output may be the canonicalized form (macOS /var → /private/var).
    expect(text).toContain("fmt-test.ts");
    expect(text).toContain("bytes");
    expect(text).not.toContain("// hello");
  });
});

// ---------------------------------------------------------------------------
// Existing file (delegates to ashlrEdit)
// ---------------------------------------------------------------------------

describe("ashlr__write · existing file", () => {
  test("returns edit result (diff format) for existing file", async () => {
    const filePath = join(tmpDir, "existing.ts");
    const original = "export const a = 1;\n";
    const updated = "export const a = 2;\n";
    await writeFile(filePath, original, "utf-8");

    const result = await ashlrWrite({ filePath, content: updated });

    expect(result.kind).toBe("existing");
    if (result.kind !== "existing") throw new Error("expected existing");
    // ashlrEdit returns hunksApplied.
    expect(result.editResult.hunksApplied).toBe(1);
  });

  test("existing file is updated on disk", async () => {
    const filePath = join(tmpDir, "update.ts");
    const original = "const x = 'old';\n";
    const updated = "const x = 'new';\n";
    await writeFile(filePath, original, "utf-8");

    await ashlrWrite({ filePath, content: updated });

    const onDisk = await readFile(filePath, "utf-8");
    expect(onDisk).toBe(updated);
  });

  test("formatWriteResult for existing file uses edit diff format", async () => {
    const filePath = join(tmpDir, "fmt-existing.ts");
    // Use a multi-line file so we can verify the response is compact (only a
    // summary line, not the full file).
    const original = Array.from({ length: 20 }, (_, i) => `const line${i} = ${i};\n`).join("");
    const updated = original.replace("const line0 = 0;", "const line0 = 999;");
    await writeFile(filePath, original, "utf-8");

    const result = await ashlrWrite({ filePath, content: updated });
    const text = formatWriteResult(result);

    // ashlrEdit diff format contains [ashlr__edit].
    expect(text).toContain("ashlr__edit");
    // The response is a compact summary — it must be much shorter than the full file.
    expect(text.length).toBeLessThan(original.length);
    // It should NOT contain all 20 lines verbatim.
    expect(text).not.toContain("const line19 = 19;");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("ashlr__write · edge cases", () => {
  test("empty new file writes successfully", async () => {
    const filePath = join(tmpDir, "empty.ts");

    const result = await ashlrWrite({ filePath, content: "" });

    expect(result.kind).toBe("new");
    if (result.kind !== "new") throw new Error("expected new");
    expect(result.ack.bytes).toBe(0);

    const onDisk = await readFile(filePath, "utf-8");
    expect(onDisk).toBe("");
  });

  test("rejects path outside cwd", async () => {
    await expect(
      ashlrWrite({ filePath: "/etc/passwd", content: "oops" }),
    ).rejects.toThrow();
  });
});
