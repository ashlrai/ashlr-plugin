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
import { mkdtemp, rm, unlink, writeFile } from "fs/promises";
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

  test("invalidating an absent entry leaves another entry unchanged", async () => {
    const { getCached, setCached } = await import("../servers/_read-cache");
    const missingPath = join(tmp, "missing.ts");
    const cachedPath = join(tmp, "cached.ts");
    const entry = { mtimeMs: 12345, result: "cached content", sourceBytes: 14 };
    setCached(cachedPath, entry);

    expect(getCached(missingPath)).toBeUndefined();
    expect(() => invalidateCached(missingPath)).not.toThrow();
    expect(getCached(missingPath)).toBeUndefined();
    expect(getCached(cachedPath)).toEqual(entry);
  });

  test("editing one cached path leaves an unrelated path cached", async () => {
    const editedPath = join(tmp, "edited.ts");
    const unrelatedPath = join(tmp, "unrelated.ts");
    await writeFile(editedPath, "const version = 1;\n");
    await writeFile(unrelatedPath, "const other = true;\n");

    for (const path of [editedPath, unrelatedPath]) {
      expect(await ashlrRead({ path, bypassSummary: false })).not.toContain("(cached)");
      expect(await ashlrRead({ path, bypassSummary: false })).toContain("(cached)");
    }

    const editResult = await ashlrEdit({
      path: editedPath,
      search: "const version = 1;",
      replace: "const version = 2;",
      strict: true,
    });
    expect(editResult.hunksApplied).toBe(1);

    const edited = await ashlrRead({ path: editedPath, bypassSummary: false });
    expect(edited).not.toContain("(cached)");
    expect(edited).toContain("version = 2");

    const unrelated = await ashlrRead({ path: unrelatedPath, bypassSummary: false });
    expect(unrelated).toContain("(cached)");
    expect(unrelated).toContain("other = true");
  });
  test("deleting a cached file means a later read does not return its cached content", async () => {
    const filePath = join(tmp, "doomed.ts");
    await writeFile(filePath, "const secretMarker = 'stale-content';\n");

    expect(await ashlrRead({ path: filePath, bypassSummary: false })).not.toContain("(cached)");
    const warm = await ashlrRead({ path: filePath, bypassSummary: false });
    expect(warm).toContain("(cached)");
    expect(warm).toContain("stale-content");

    await unlink(filePath);

    let after: string | undefined;
    try {
      after = await ashlrRead({ path: filePath, bypassSummary: false });
    } catch (err) {
      // Throwing is also acceptable, as long as the error does not leak cached content.
      expect(String(err)).not.toContain("stale-content");
    }
    if (after !== undefined) {
      expect(after).not.toContain("stale-content");
      expect(after).not.toContain("(cached)");
    }
  });
});
