/**
 * read-cache-invalidation — confirms that edit-server's invalidateCached()
 * call propagates to read-server so stale content is never served after a write.
 *
 * Scenario:
 *   1. Write a file and read it via ashlrRead → result gets cached.
 *   2. Confirm repeated ashlrRead returns "(cached)" prefix.
 *   3. Edit the file via ashlrEdit (updates disk + calls invalidateCached).
 *   4. Confirm ashlrRead returns the NEW content (no "(cached)" prefix).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// Import the module-level singletons directly — same process, same cache.
import { ashlrRead } from "../servers/read-server";
import { ashlrEdit } from "../servers/edit-server";
import { invalidateCached } from "../servers/_read-cache";

describe("read-cache-invalidation", () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = await mkdtemp(join(tmpdir(), "ashlr-cache-inv-"));
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmp, { recursive: true, force: true });
  });

  test("edit-server invalidates read-cache so ashlrRead returns fresh content", async () => {
    const filePath = join(tmp, "target.ts");
    const initialContent = "const version = 1;\n";
    const updatedContent = "const version = 2;\n";

    // Write the file.
    await writeFile(filePath, initialContent, "utf-8");

    // First read — populates cache (must NOT use bypassSummary:true; that skips caching).
    const first = await ashlrRead({ path: filePath, bypassSummary: false });
    expect(first).toContain("version = 1");
    expect(first).not.toContain("(cached)");

    // Second read — should hit cache (same mtime).
    const second = await ashlrRead({ path: filePath, bypassSummary: false });
    // Cache hit returns "(cached)\n..." prefix.
    expect(second).toContain("(cached)");
    expect(second).toContain("version = 1");

    // Edit the file via edit-server — this invalidates the cache entry.
    const editResult = await ashlrEdit({
      path: filePath,
      search: "const version = 1;",
      replace: "const version = 2;",
      strict: true,
    });
    expect(editResult.hunksApplied).toBe(1);

    // Third read — cache is invalidated; must return fresh content.
    const third = await ashlrRead({ path: filePath, bypassSummary: false });
    expect(third).not.toContain("(cached)");
    expect(third).toContain("version = 2");
    expect(third).not.toContain("version = 1");
  });

  test("invalidateCached directly marks entry stale so getCached misses", async () => {
    const { getCached, setCached } = await import("../servers/_read-cache");

    const abs = "/fake/path/to/file.ts";
    // Seed a cache entry with a fake mtime.
    setCached(abs, { mtimeMs: 12345, result: "old content", sourceBytes: 11 });

    // Entry should be present and match mtime 12345.
    const before = getCached(abs);
    expect(before).toBeDefined();
    expect(before!.mtimeMs).toBe(12345);

    // Invalidate.
    invalidateCached(abs);

    // Entry still exists but mtimeMs is -1 (guaranteed mismatch).
    const after = getCached(abs);
    expect(after).toBeDefined();
    expect(after!.mtimeMs).toBe(-1);
  });
});
