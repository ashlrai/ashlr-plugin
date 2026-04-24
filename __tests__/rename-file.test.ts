/**
 * rename-file.test.ts — v1.19 module-path rename (ashlr__rename_file).
 *
 * Covers:
 *   - Dry-run happy path: lists every planned edit, nothing on disk changes.
 *   - Apply: actually renames + updates importers.
 *   - Extension elision: `import "./foo"` becomes `./bar` (no extension added).
 *   - Index variant: renaming `foo/index.ts` → `bar/index.ts` updates `./foo` → `./bar`.
 *   - Bare package specifiers (`react`) are untouched.
 *   - Refusals: outside-cwd, destination-exists, binary extensions.
 *   - Directory-missing refusal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  ashlrRenameFile,
  planRenameFile,
} from "../servers/rename-file-server";

let tmpProj: string;
const ORIGINAL_CWD = process.cwd();

// The cwd-clamp helper needs the tmp dir to be inside an allow-listed root.
// `process.chdir(tmpProj)` accomplishes that for the duration of each test;
// afterEach restores cwd unconditionally so peers aren't affected.
beforeEach(async () => {
  tmpProj = await mkdtemp(join(tmpdir(), "ashlr-rename-file-"));
  process.chdir(tmpProj);
});

afterEach(async () => {
  if (process.cwd() !== ORIGINAL_CWD) {
    try { process.chdir(ORIGINAL_CWD); } catch { /* ignore */ }
  }
  await rm(tmpProj, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Dry-run happy path — 3 importers across nested dirs
// ---------------------------------------------------------------------------

describe("ashlr__rename_file · dry run", () => {
  test("lists every planned edit and does not modify disk", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    await mkdir(join(src, "nested"), { recursive: true });

    const fooPath = join(src, "foo.ts");
    const other1 = join(src, "other1.ts");
    const other2 = join(src, "other2.ts");
    const three = join(src, "nested", "three.ts");

    await writeFile(fooPath, `export const foo = 42;\n`);
    await writeFile(other1, `import { foo } from "./foo";\nexport const x = foo;\n`);
    await writeFile(other2, `import { foo } from "./foo.ts";\nexport const y = foo;\n`);
    await writeFile(three, `import { foo } from "../foo";\nexport const z = foo;\n`);

    const before1 = await readFile(other1, "utf-8");
    const before2 = await readFile(other2, "utf-8");
    const before3 = await readFile(three, "utf-8");

    const out = await ashlrRenameFile({
      from: "src/foo.ts",
      to: "src/bar.ts",
      dryRun: true,
    });

    // Summary shape
    expect(out).toContain("[ashlr__rename_file]");
    expect(out).toContain("(dry run)");
    expect(out).toContain("3 importers");
    expect(out).toContain('"./foo" → "./bar"');
    expect(out).toContain('"./foo.ts" → "./bar.ts"');
    expect(out).toContain('"../foo" → "../bar"');

    // Nothing was changed on disk
    expect(await exists(fooPath)).toBe(true);
    expect(await exists(join(src, "bar.ts"))).toBe(false);
    expect(await readFile(other1, "utf-8")).toBe(before1);
    expect(await readFile(other2, "utf-8")).toBe(before2);
    expect(await readFile(three, "utf-8")).toBe(before3);
  });
});

// ---------------------------------------------------------------------------
// Apply mode — actually writes + renames
// ---------------------------------------------------------------------------

describe("ashlr__rename_file · apply", () => {
  test("renames file and updates every importer", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    await mkdir(join(src, "nested"), { recursive: true });

    const fooPath = join(src, "foo.ts");
    const other1 = join(src, "other1.ts");
    const other2 = join(src, "other2.ts");
    const three = join(src, "nested", "three.ts");

    await writeFile(fooPath, `export const foo = 42;\n`);
    await writeFile(other1, `import { foo } from "./foo";\nexport const x = foo;\n`);
    await writeFile(other2, `import { foo } from "./foo.ts";\nexport const y = foo;\n`);
    await writeFile(three, `import { foo } from "../foo";\nexport const z = foo;\n`);

    const out = await ashlrRenameFile({
      from: "src/foo.ts",
      to: "src/bar.ts",
    });

    expect(out).toContain("3 importers");
    expect(out).toContain("renamed");

    // File moved
    expect(await exists(fooPath)).toBe(false);
    expect(await exists(join(src, "bar.ts"))).toBe(true);

    // Importer bodies updated
    expect(await readFile(other1, "utf-8")).toBe(
      `import { foo } from "./bar";\nexport const x = foo;\n`,
    );
    expect(await readFile(other2, "utf-8")).toBe(
      `import { foo } from "./bar.ts";\nexport const y = foo;\n`,
    );
    expect(await readFile(three, "utf-8")).toBe(
      `import { foo } from "../bar";\nexport const z = foo;\n`,
    );
  });

  test("rename with zero importers still moves the file", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    const fooPath = join(src, "foo.ts");
    await writeFile(fooPath, `export const foo = 1;\n`);

    const out = await ashlrRenameFile({
      from: "src/foo.ts",
      to: "src/bar.ts",
    });

    expect(out).toContain("renamed");
    expect(await exists(fooPath)).toBe(false);
    expect(await exists(join(src, "bar.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Extension elision
// ---------------------------------------------------------------------------

describe("ashlr__rename_file · extension elision", () => {
  test("preserves the original no-extension specifier style", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });

    await writeFile(join(src, "foo.ts"), `export const foo = 1;\n`);
    const importer = join(src, "consumer.ts");
    await writeFile(
      importer,
      `import { foo } from "./foo";\nimport { bar } from "react";\n`,
    );

    await ashlrRenameFile({
      from: "src/foo.ts",
      to: "src/bar.ts",
    });

    // The `./foo` (no extension) stays extension-less as `./bar`.
    const after = await readFile(importer, "utf-8");
    expect(after).toContain('import { foo } from "./bar";');
    // `react` is unchanged.
    expect(after).toContain('import { bar } from "react";');
    expect(after).not.toContain("./bar.ts");
  });

  test("preserves the original with-extension specifier style", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });

    await writeFile(join(src, "foo.ts"), `export const foo = 1;\n`);
    const importer = join(src, "consumer.ts");
    await writeFile(importer, `import { foo } from "./foo.ts";\n`);

    await ashlrRenameFile({
      from: "src/foo.ts",
      to: "src/bar.ts",
    });

    const after = await readFile(importer, "utf-8");
    expect(after).toBe(`import { foo } from "./bar.ts";\n`);
  });
});

// ---------------------------------------------------------------------------
// Index variant
// ---------------------------------------------------------------------------

describe("ashlr__rename_file · index variant", () => {
  test("renaming foo/index.ts → bar/index.ts rewrites './foo' to './bar'", async () => {
    const src = join(tmpProj, "src");
    await mkdir(join(src, "foo"), { recursive: true });
    await mkdir(join(src, "bar"), { recursive: true });

    await writeFile(join(src, "foo", "index.ts"), `export const foo = 1;\n`);
    const importer = join(src, "consumer.ts");
    await writeFile(importer, `import { foo } from "./foo";\n`);

    const out = await ashlrRenameFile({
      from: "src/foo/index.ts",
      to: "src/bar/index.ts",
    });

    expect(out).toContain("renamed");
    const after = await readFile(importer, "utf-8");
    expect(after).toBe(`import { foo } from "./bar";\n`);
  });
});

// ---------------------------------------------------------------------------
// Bare package specifiers are untouched
// ---------------------------------------------------------------------------

describe("ashlr__rename_file · bare specifiers", () => {
  test("'react' and '@scope/pkg' are never rewritten", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });

    await writeFile(join(src, "foo.ts"), `export const foo = 1;\n`);
    const importer = join(src, "consumer.ts");
    const body =
      `import React from "react";\n` +
      `import { scope } from "@scope/pkg";\n` +
      `import { foo } from "./foo";\n`;
    await writeFile(importer, body);

    await ashlrRenameFile({
      from: "src/foo.ts",
      to: "src/bar.ts",
    });

    const after = await readFile(importer, "utf-8");
    expect(after).toContain('import React from "react";');
    expect(after).toContain('import { scope } from "@scope/pkg";');
    expect(after).toContain('import { foo } from "./bar";');
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("ashlr__rename_file · refusals", () => {
  test("outside-cwd 'from' is refused", async () => {
    await expect(
      ashlrRenameFile({ from: "/etc/hostname", to: "src/x.ts" }),
    ).rejects.toThrow(/refused path outside working directory/);
  });

  test("outside-cwd 'to' is refused", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "foo.ts"), "x");
    await expect(
      ashlrRenameFile({ from: "src/foo.ts", to: "/tmp/should-refuse.ts" }),
    ).rejects.toThrow(/refused path outside working directory/);
  });

  test("existing destination is refused", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "foo.ts"), "x");
    await writeFile(join(src, "bar.ts"), "y");
    await expect(
      ashlrRenameFile({ from: "src/foo.ts", to: "src/bar.ts" }),
    ).rejects.toThrow(/'to' already exists/);
  });

  test("binary extension on 'from' is refused", async () => {
    const assets = join(tmpProj, "assets");
    await mkdir(assets, { recursive: true });
    await writeFile(join(assets, "hero.png"), "fake-png");
    await expect(
      ashlrRenameFile({ from: "assets/hero.png", to: "assets/banner.png" }),
    ).rejects.toThrow(/binary files are not supported/);
  });

  test("binary extension on 'to' is refused", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "foo.ts"), "x");
    await expect(
      ashlrRenameFile({ from: "src/foo.ts", to: "src/foo.pdf" }),
    ).rejects.toThrow(/binary files are not supported/);
  });

  test("missing destination directory is refused", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "foo.ts"), "x");
    await expect(
      ashlrRenameFile({ from: "src/foo.ts", to: "src/subdir-does-not-exist/bar.ts" }),
    ).rejects.toThrow(/destination directory does not exist/);
  });

  test("missing 'from' is refused", async () => {
    await expect(
      ashlrRenameFile({ from: "src/nope.ts", to: "src/also-nope.ts" }),
    ).rejects.toThrow(/does not exist/);
  });

  test("same-path rename is refused", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "foo.ts"), "x");
    await expect(
      ashlrRenameFile({ from: "src/foo.ts", to: "src/foo.ts" }),
    ).rejects.toThrow(/resolve to the same path/);
  });
});

// ---------------------------------------------------------------------------
// Plan inspection (internal surface)
// ---------------------------------------------------------------------------

describe("planRenameFile · plan shape", () => {
  test("returns per-file edits with start/end byte offsets inside quote pairs", async () => {
    const src = join(tmpProj, "src");
    await mkdir(src, { recursive: true });

    await writeFile(join(src, "foo.ts"), "export const foo = 1;\n");
    const importer = join(src, "consumer.ts");
    const body = `import { foo } from "./foo";\n`;
    await writeFile(importer, body);

    const result = await planRenameFile({
      from: "src/foo.ts",
      to: "src/bar.ts",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.edits.length).toBe(1);
    const fe = result.plan.edits[0]!;
    // Candidate paths come back canonicalized (macOS /var → /private/var),
    // so compare against the importer's realpath.
    expect(fe.path).toBe(realpathSync(importer));
    expect(fe.edits.length).toBe(1);

    const edit = fe.edits[0]!;
    expect(edit.oldSpecifier).toBe("./foo");
    expect(edit.newSpecifier).toBe("./bar");
    // The [start, end) range should exactly cover the specifier text,
    // surrounded by the quotes in the source.
    expect(body.slice(edit.start, edit.end)).toBe("./foo");
    expect(body[edit.start - 1]).toBe('"');
    expect(body[edit.end]).toBe('"');
  });
});
