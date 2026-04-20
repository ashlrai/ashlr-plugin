/**
 * Tests for _bash-summarizers-registry.ts
 * Verifies the registry exposes every summarizer and findSummarizer matches expected commands.
 */

import { describe, expect, test } from "bun:test";
import {
  BASH_SUMMARIZERS,
  findSummarizer,
} from "../servers/_bash-summarizers-registry.js";

// ---------------------------------------------------------------------------
// Registry completeness
// ---------------------------------------------------------------------------

const EXPECTED_KEYS = [
  "git-status",
  "ls",
  "find",
  "ps",
  "npm-ls",
  "bun-pm-ls",
  "docker-ps",
  "docker-compose-ps",
  "docker-container-ls",
  "kubectl-get",
  "npm-audit",
];

describe("BASH_SUMMARIZERS registry", () => {
  test("contains all expected keys", () => {
    for (const key of EXPECTED_KEYS) {
      expect(BASH_SUMMARIZERS.has(key)).toBe(true);
    }
  });

  test("every value is a function", () => {
    for (const [key, fn] of BASH_SUMMARIZERS) {
      expect(typeof fn).toBe("function");
    }
  });

  test("has exactly the expected number of entries", () => {
    expect(BASH_SUMMARIZERS.size).toBe(EXPECTED_KEYS.length);
  });
});

// ---------------------------------------------------------------------------
// findSummarizer — command matching
// ---------------------------------------------------------------------------

describe("findSummarizer", () => {
  const cases: Array<[string, string | null]> = [
    // git status variants
    ["git status", "git-status"],
    ["git status --porcelain", "git-status"],
    ["git status -s", "git-status"],

    // ls variants
    ["ls", "ls"],
    ["ls -la", "ls"],
    ["ls -l /tmp", "ls"],

    // find
    ["find . -name '*.ts'", "find"],
    ["find /tmp -type f", "find"],

    // ps
    ["ps aux", "ps"],
    ["ps -ef", "ps"],

    // npm ls
    ["npm ls", "npm-ls"],
    ["npm ls --depth=0", "npm-ls"],

    // bun pm ls
    ["bun pm ls", "bun-pm-ls"],

    // docker ps
    ["docker ps", "docker-ps"],
    ["docker ps -a", "docker-ps"],

    // docker-compose ps
    ["docker-compose ps", "docker-compose-ps"],

    // docker container ls
    ["docker container ls", "docker-container-ls"],

    // kubectl get
    ["kubectl get pods", "kubectl-get"],
    ["kubectl get pods -n default", "kubectl-get"],

    // npm audit
    ["npm audit", "npm-audit"],
    ["npm audit --json", "npm-audit"],

    // non-matching commands
    ["echo hello", null],
    ["cat file.txt", null],
    ["git diff", null],
    ["npm install", null],
    ["", null],
  ];

  for (const [cmd, expectedKey] of cases) {
    test(`"${cmd}" → ${expectedKey ?? "null"}`, () => {
      const fn = findSummarizer(cmd);
      if (expectedKey === null) {
        expect(fn).toBeNull();
      } else {
        expect(fn).not.toBeNull();
        expect(fn).toBe(BASH_SUMMARIZERS.get(expectedKey) ?? null);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Smoke tests — summarizers return expected shapes
// ---------------------------------------------------------------------------

describe("summarizer smoke tests via registry", () => {
  test("git-status: clean working tree", () => {
    const fn = BASH_SUMMARIZERS.get("git-status")!;
    expect(fn("")).toBe("clean");
  });

  test("git-status: counts modified files", () => {
    const fn = BASH_SUMMARIZERS.get("git-status")!;
    const porcelain = "M  foo.ts\nM  bar.ts\n?? baz.ts\n";
    const result = fn(porcelain);
    expect(result).toContain("M");
    expect(result).toContain("??");
  });

  test("ls: returns null for short output", () => {
    const fn = BASH_SUMMARIZERS.get("ls")!;
    const short = Array.from({ length: 10 }, (_, i) => `file${i}.ts`).join("\n");
    expect(fn(short)).toBeNull();
  });

  test("ls: truncates long output", () => {
    const fn = BASH_SUMMARIZERS.get("ls")!;
    const long = Array.from({ length: 50 }, (_, i) => `file${i}.ts`).join("\n");
    const result = fn(long);
    expect(result).not.toBeNull();
    expect(result).toContain("entries total");
  });

  test("find: returns null for short output", () => {
    const fn = BASH_SUMMARIZERS.get("find")!;
    const short = Array.from({ length: 20 }, (_, i) => `./file${i}.ts`).join("\n");
    expect(fn(short)).toBeNull();
  });

  test("find: truncates long output", () => {
    const fn = BASH_SUMMARIZERS.get("find")!;
    const long = Array.from({ length: 150 }, (_, i) => `./file${i}.ts`).join("\n");
    const result = fn(long);
    expect(result).not.toBeNull();
    expect(result).toContain("matches total");
  });

  test("npm-audit: returns null for short output", () => {
    const fn = BASH_SUMMARIZERS.get("npm-audit")!;
    expect(fn("no vulnerabilities found\n")).toBeNull();
  });

  test("npm-audit: summarizes JSON output", () => {
    const fn = BASH_SUMMARIZERS.get("npm-audit")!;
    // JSON must have >= 10 lines to pass the early-exit guard.
    const json = JSON.stringify(
      {
        metadata: { vulnerabilities: { high: 2, low: 1 } },
        vulnerabilities: {
          lodash: { severity: "high", via: [{ title: "Prototype Pollution", url: "https://example.com" }] },
          minimist: { severity: "low", via: [{ title: "ReDOS", url: "https://example.com" }] },
        },
      },
      null,
      2,
    );
    // Pad to >= 10 lines if needed.
    const padded = json + "\n".repeat(Math.max(0, 10 - json.split("\n").length));
    const result = fn(padded);
    expect(result).not.toBeNull();
    expect(result).toContain("npm audit:");
    expect(result).toContain("high: 2");
  });
});
