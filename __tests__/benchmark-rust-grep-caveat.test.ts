/**
 * Guards the Rust grep caveat in docs/benchmarks.md — the "**Grep
 * patterns:**" workload list plus the "**Note on grep for Rust:**"
 * discussion — against the recorded samples in docs/benchmarks-v2.json.
 *
 * Asserts:
 *   - every pattern named in the caveat is present in the recorded
 *     ashlr__grep benchmark patterns (exact strings, trailing spaces
 *     included), and the recorded set contains no undocumented extras
 *   - the named workload still matches the runner's GREP_PATTERNS
 *   - keywords the note discusses (`TODO`, `class`, `interface`) resolve to
 *     recorded patterns, while the Rust constructs it names (`use`, `fn`,
 *     and the illustrative `rg -n 'use '`) stay unmeasured as it claims
 *   - the rust-project reference the caveat describes exists in the data
 *     and shows the weakest grep ratio the caveat explains
 *   - the caveat's premise holds in the checked-in ref repo: `use `/`fn `
 *     outmatch the measured `import `/`function ` there
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { GREP_PATTERNS } from "../scripts/run-benchmark";

const DOCS = new URL("../docs/benchmarks.md", import.meta.url);
const DATA = new URL("../docs/benchmarks-v2.json", import.meta.url);
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function caveatBlock(docs: string): string {
  const block = docs.match(/\*\*Grep patterns:\*\*[\s\S]*?(?=\n### )/);
  expect(block).not.toBeNull();
  expect(block![0]).toContain("**Note on grep for Rust:**");
  return block![0];
}

function namedPatterns(caveat: string): string[] {
  const list = caveat.match(/```json\s*\n([\s\S]*?)\n```/);
  expect(list).not.toBeNull();
  const patterns: unknown = JSON.parse(list![1]!);
  expect(Array.isArray(patterns)).toBe(true);
  expect((patterns as string[]).length).toBeGreaterThan(0);
  return patterns as string[];
}

function recordedPatterns(): string[] {
  const data = JSON.parse(readFileSync(DATA, "utf8"));
  return data.samples.ashlr__grep.map((sample: { pattern: string }) => sample.pattern);
}

describe("Rust grep caveat in docs/benchmarks.md", () => {
  test("each pattern named in the caveat is present in the recorded benchmark patterns", () => {
    const named = namedPatterns(caveatBlock(readFileSync(DOCS, "utf8")));
    const recorded = recordedPatterns();
    for (const pattern of named) {
      expect(recorded).toContain(pattern);
    }
  });

  test("the caveat names exactly the recorded and configured workload, in order", () => {
    const named = namedPatterns(caveatBlock(readFileSync(DOCS, "utf8")));
    expect(named).toEqual(recordedPatterns());
    expect(named).toEqual([...GREP_PATTERNS]);
  });

  test("keyword mentions resolve to recorded patterns while named Rust constructs stay unmeasured", () => {
    const caveat = caveatBlock(readFileSync(DOCS, "utf8"));
    const recorded = recordedPatterns();

    // Measured patterns the note discusses by keyword — verbatim (`TODO`)
    // or as the stem of a trailing-space pattern (`class `, `interface `).
    for (const keyword of ["TODO", "class", "interface"]) {
      expect(caveat).toContain(`\`${keyword}\``);
      expect(recorded.some((pattern) => pattern === keyword || pattern === `${keyword} `)).toBe(true);
    }

    // Rust forms the caveat names — `use`, `fn`, and the illustrative
    // `rg -n 'use '` — are documented as unmeasured, so none is recorded.
    for (const mention of ["`use`", "`fn`", "rg -n 'use '", "not a measured pattern"]) {
      expect(caveat).toContain(mention);
    }
    for (const rustForm of ["use", "use ", "fn", "fn "]) {
      expect(recorded).not.toContain(rustForm);
    }
  });

  test("the caveat describes the recorded rust-project reference", () => {
    const caveat = caveatBlock(readFileSync(DOCS, "utf8"));
    const data = JSON.parse(readFileSync(DATA, "utf8"));

    expect(caveat).toContain("bench/refs/rust-project");
    const rust = data.byRepo["rust-project"];
    expect(rust.language).toBe("rs");
    expect(typeof rust.perTool.grep.mean).toBe("number");

    // The caveat explains that few matches leave little output to truncate;
    // consistent with that, the recorded Rust grep ratio is the weakest
    // (highest) of the three reference repos.
    for (const key of ["node-sdk", "python-lib"]) {
      expect(rust.perTool.grep.mean).toBeGreaterThanOrEqual(data.byRepo[key].perTool.grep.mean);
    }
  });

  test("the illustrative `use ` search outmatches the measured `import ` in the real ref repo", () => {
    const caveat = caveatBlock(readFileSync(DOCS, "utf8"));
    const example = caveat.match(/`rg -n 'use ' (bench\/refs\/rust-project)`/);
    expect(example).not.toBeNull();

    const count = (pattern: string): number => {
      const result = spawnSync("rg", ["-n", pattern, example![1]!], { cwd: ROOT, encoding: "utf8" });
      expect([0, 1]).toContain(result.status); // 0 = matches, 1 = none, 2 = error
      return result.stdout.trim().split("\n").filter(Boolean).length;
    };

    // The caveat's premise: Rust reaches for `use`/`fn` while the measured
    // `import `/`function ` patterns hit only incidental text. Assert the
    // direction (the vendored ref is pinned by .refrev), not exact counts.
    expect(count("use ")).toBeGreaterThan(count("import "));
    expect(count("fn ")).toBeGreaterThan(count("function "));
  });

  test("the guard rejects a missing or extra documented pattern", () => {
    const docs = readFileSync(DOCS, "utf8");
    const missing = docs.replace('"TODO", ', "");
    const extra = docs.replace('"TODO", ', '"TODO", "extra ", ');
    expect(missing).not.toBe(docs);
    expect(extra).not.toBe(docs);
    expect(namedPatterns(caveatBlock(missing))).not.toEqual(recordedPatterns());
    expect(namedPatterns(caveatBlock(extra))).not.toEqual(recordedPatterns());
  });
});
