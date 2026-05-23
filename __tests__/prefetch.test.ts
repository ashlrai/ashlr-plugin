/**
 * Tests for servers/_prefetch.ts — Predictive Prefetch MVP.
 *
 * Covers:
 *   - Tier gates: free / pro / team caps.
 *   - ASHLR_PREFETCH=off kill switch.
 *   - Idempotency (same path doesn't double-cache).
 *   - 1.5s hard wallclock cap honoured under slow I/O.
 *   - Cache hit on subsequent ashlr__read of a prefetched neighbour.
 *   - Import-extraction regex coverage.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  _resetInflightForTest,
  _setReadImplForTest,
  extractImports,
  isPrefetchDisabled,
  resolveImport,
  schedulePrefetch,
  tierCap,
} from "../servers/_prefetch";
import { getCached } from "../servers/_read-cache";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let root: string;
let origPrefetch: string | undefined;
let origAllow: string | undefined;

beforeEach(async () => {
  // Canonicalize so macOS /var → /private/var matches the clampToCwd output.
  root = realpathSync(await mkdtemp(join(tmpdir(), "ashlr-prefetch-")));
  origPrefetch = process.env["ASHLR_PREFETCH"];
  origAllow = process.env["ASHLR_ALLOW_PROJECT_PATHS"];
  delete process.env["ASHLR_PREFETCH"];
  // Open the cwd-clamp so resolveImport/setCached can target the tmp root.
  process.env["ASHLR_ALLOW_PROJECT_PATHS"] = root;
  _resetInflightForTest();
  _setReadImplForTest(null);
});

afterEach(async () => {
  if (origPrefetch !== undefined) process.env["ASHLR_PREFETCH"] = origPrefetch;
  else delete process.env["ASHLR_PREFETCH"];
  if (origAllow !== undefined) process.env["ASHLR_ALLOW_PROJECT_PATHS"] = origAllow;
  else delete process.env["ASHLR_ALLOW_PROJECT_PATHS"];
  _resetInflightForTest();
  _setReadImplForTest(null);
  await rm(root, { recursive: true, force: true });
});

async function writeFixture(rel: string, content: string): Promise<string> {
  const abs = join(root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf-8");
  return abs;
}

/** Build a TS file that imports N sibling files. */
async function makeFixtureWithImports(count: number): Promise<{ root: string; mainAbs: string; neighbours: string[] }> {
  const neighbours: string[] = [];
  for (let i = 0; i < count; i++) {
    const abs = await writeFixture(`n${i}.ts`, `export const VAL_${i} = ${i};\n`);
    neighbours.push(abs);
  }
  const importLines = neighbours.map((_, i) => `import { VAL_${i} } from "./n${i}";`).join("\n");
  const mainAbs = await writeFixture("main.ts", importLines + "\nexport const M = 1;\n");
  return { root, mainAbs, neighbours };
}

// ---------------------------------------------------------------------------
// Pure-unit tests
// ---------------------------------------------------------------------------

describe("tierCap", () => {
  test("free → 0", () => {
    expect(tierCap("free")).toBe(0);
  });
  test("pro → 3", () => {
    expect(tierCap("pro")).toBe(3);
  });
  test("team → 10", () => {
    expect(tierCap("team")).toBe(10);
  });
});

describe("isPrefetchDisabled", () => {
  test("default → false", () => {
    expect(isPrefetchDisabled({})).toBe(false);
  });
  test("off / 0 / false / no → true", () => {
    for (const v of ["off", "OFF", "0", "false", "no"]) {
      expect(isPrefetchDisabled({ ASHLR_PREFETCH: v })).toBe(true);
    }
  });
  test("on → false (not a kill switch value)", () => {
    expect(isPrefetchDisabled({ ASHLR_PREFETCH: "on" })).toBe(false);
  });
});

describe("extractImports", () => {
  test("TS ES imports + require + python + C/C++ include", () => {
    const src = [
      `import { A } from "./a";`,
      `import B from "./b";`,
      `const c = require("./c");`,
      `from package import x`,
      `import sys`,
      `#include "stdio.h"`,
      `#include <vector>`,
    ].join("\n");
    const imports = extractImports(src);
    expect(imports).toContain("./a");
    expect(imports).toContain("./b");
    expect(imports).toContain("./c");
    expect(imports).toContain("package");
    expect(imports).toContain("sys");
    expect(imports).toContain("stdio.h");
    expect(imports).toContain("vector");
  });

  test("frequency-rank: duplicated import ranks higher", () => {
    const src = `import a from "./a";\nimport a2 from "./a";\nimport b from "./b";`;
    const imports = extractImports(src);
    expect(imports[0]).toBe("./a");
    expect(imports[1]).toBe("./b");
  });
});

// ---------------------------------------------------------------------------
// Tier-gate behaviour
// ---------------------------------------------------------------------------

describe("schedulePrefetch — tier gates", () => {
  test("free tier → no neighbours fetched", async () => {
    const { mainAbs } = await makeFixtureWithImports(5);
    const res = await schedulePrefetch(mainAbs, { tier: "free", maxNeighbors: 10, cwd: root });
    expect(res.skipped).toBe("free-tier");
    expect(res.completed).toBe(0);
  });

  test("pro tier → top 3 cached even when caller asks for 10", async () => {
    const { mainAbs, neighbours } = await makeFixtureWithImports(5);
    const res = await schedulePrefetch(mainAbs, { tier: "pro", maxNeighbors: 10, cwd: root });
    expect(res.scheduled).toBe(3);
    expect(res.completed).toBe(3);
    // The first 3 fixture neighbours should be in the cache.
    let hits = 0;
    for (const n of neighbours.slice(0, 3)) {
      if (getCached(n)) hits++;
    }
    expect(hits).toBe(3);
  });

  test("team tier → top 10 (or all available)", async () => {
    const { mainAbs, neighbours } = await makeFixtureWithImports(10);
    const res = await schedulePrefetch(mainAbs, { tier: "team", maxNeighbors: 10, cwd: root });
    expect(res.scheduled).toBe(10);
    expect(res.completed).toBe(10);
    let hits = 0;
    for (const n of neighbours) {
      if (getCached(n)) hits++;
    }
    expect(hits).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe("ASHLR_PREFETCH=off kill switch", () => {
  test("off → no work regardless of tier", async () => {
    process.env["ASHLR_PREFETCH"] = "off";
    const { mainAbs } = await makeFixtureWithImports(5);
    const res = await schedulePrefetch(mainAbs, { tier: "team", maxNeighbors: 10, cwd: root });
    expect(res.skipped).toBe("kill-switch");
    expect(res.completed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  test("two concurrent schedules for the same path → second is no-op", async () => {
    const { mainAbs } = await makeFixtureWithImports(3);
    const [a, b] = await Promise.all([
      schedulePrefetch(mainAbs, { tier: "pro", maxNeighbors: 10, cwd: root }),
      schedulePrefetch(mainAbs, { tier: "pro", maxNeighbors: 10, cwd: root }),
    ]);
    // Exactly one of the two should be the idempotent skip; the other does work.
    const skipped = [a, b].filter((r) => r.skipped === "idempotent").length;
    const worked = [a, b].filter((r) => r.skipped === null).length;
    expect(skipped).toBe(1);
    expect(worked).toBe(1);
  });

  test("re-prefetch of an already-cached neighbour skips redundant work", async () => {
    const { mainAbs, neighbours } = await makeFixtureWithImports(3);
    const first = await schedulePrefetch(mainAbs, { tier: "pro", maxNeighbors: 10, cwd: root });
    expect(first.completed).toBe(3);
    _resetInflightForTest(); // simulate a fresh schedule attempt

    // Track read-impl invocations on the second pass — should be zero
    // because all neighbours are cached with matching mtime.
    let reads = 0;
    _setReadImplForTest(async (p) => {
      reads++;
      const { readFile } = await import("fs/promises");
      return readFile(p, "utf-8");
    });
    const second = await schedulePrefetch(mainAbs, { tier: "pro", maxNeighbors: 10, cwd: root });
    // The main file itself is read once (we re-extract imports). Neighbours
    // already cached → no extra reads.
    expect(reads).toBe(1);
    expect(second.completed).toBe(0);
    expect(neighbours.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 1.5s wallclock cap
// ---------------------------------------------------------------------------

describe("1.5s hard wallclock cap", () => {
  test("slow filesystem → cap honoured, partial completion OK", async () => {
    const { mainAbs } = await makeFixtureWithImports(5);

    // Mock every read to stall 800ms — at 5 neighbours that's 4s sequential,
    // well past the 1.5s budget. The first read drains ~0.8s, the second
    // ~1.6s — by the third we must bail.
    _setReadImplForTest(async (p) => {
      await new Promise((r) => setTimeout(r, 800));
      const { readFile } = await import("fs/promises");
      return readFile(p, "utf-8");
    });

    const t0 = Date.now();
    const res = await schedulePrefetch(mainAbs, { tier: "pro", maxNeighbors: 10, cwd: root });
    const elapsed = Date.now() - t0;

    // 1.5s budget + a generous wiggle room for CI scheduling jitter.
    expect(elapsed).toBeLessThan(2500);
    expect(res.completed).toBeLessThanOrEqual(3);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Cache integration
// ---------------------------------------------------------------------------

describe("cache integration", () => {
  test("prefetched neighbour shows up in getCached() with prefetched marker", async () => {
    const { mainAbs, neighbours } = await makeFixtureWithImports(2);
    await schedulePrefetch(mainAbs, { tier: "pro", maxNeighbors: 10, cwd: root });
    const entry = getCached(neighbours[0]!);
    expect(entry).toBeDefined();
    expect(entry?.result.startsWith("(prefetched)")).toBe(true);
    expect(entry?.sourceBytes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("resolveImport", () => {
  test("relative .ts file resolves", async () => {
    const a = await writeFixture("a.ts", "");
    const b = await writeFixture("b.ts", "");
    expect(resolveImport("./b", a, root)).toBe(b);
  });
  test("relative dir resolves to index.ts", async () => {
    const a = await writeFixture("a.ts", "");
    const idx = await writeFixture("pkg/index.ts", "");
    expect(resolveImport("./pkg", a, root)).toBe(idx);
  });
  test("bare specifier (npm pkg) → null", async () => {
    const a = await writeFixture("a.ts", "");
    expect(resolveImport("react", a, root)).toBeNull();
  });
  test("path escape attempt → null (cwd-clamped)", async () => {
    const a = await writeFixture("a.ts", "");
    expect(resolveImport("../../../../etc/passwd", a, root)).toBeNull();
  });
});
