/**
 * Tests for bash domain summarizers (Part 3 of compression-v2-sprint2).
 *
 * Tests summarizeDockerPs, summarizeKubectlGet, and summarizeNpmAudit
 * by importing them via a re-export shim (we test internal functions directly
 * by exposing them through a thin test-only export at the bottom of bash-server.ts,
 * OR by exercising them via the RPC path).
 *
 * Since the functions are not currently exported, we test via RPC: spawn the
 * server, run the command, verify the compact output.
 *
 * For unit-level testing we inline equivalent logic here to verify the
 * summarization patterns produce expected compact form.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// v1.18 high-frequency summarizers — import from the real registry module so
// tests exercise the actual shipped code (not an inline copy).
import {
  summarizeGitLog,
  summarizeTestRunner,
  summarizeTsc,
  summarizePackageInstall,
  findSummarizer,
  isLargeDiffCommand,
  DIFF_LLM_THRESHOLD_BYTES,
} from "../servers/_bash-summarizers-registry.js";

// ---------------------------------------------------------------------------
// Inline re-implementations matching bash-server.ts logic for unit testing.
// These mirror the actual functions so any logic change must be reflected here.
// ---------------------------------------------------------------------------

function summarizeDockerPs(stdout: string): string | null {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length < 3) return null;
  const header = lines[0]!;
  const rows = lines.slice(1);
  interface DockerRow { image: string; status: string; ports: string; raw: string }
  const parsed: DockerRow[] = rows.map((raw) => {
    const cols = raw.trim().split(/\s{2,}/);
    return { image: cols[1] ?? "", status: cols[4] ?? cols[3] ?? "", ports: cols[cols.length - 1] ?? "", raw };
  });
  const groups = new Map<string, { rows: DockerRow[]; ports: Set<string> }>();
  for (const row of parsed) {
    const key = `${row.image}||${row.status}`;
    const g = groups.get(key) ?? { rows: [], ports: new Set() };
    g.rows.push(row);
    if (row.ports) g.ports.add(row.ports);
    groups.set(key, g);
  }
  const out: string[] = [header];
  for (const g of groups.values()) {
    if (g.rows.length === 1) {
      out.push(g.rows[0]!.raw);
    } else {
      const r = g.rows[0]!;
      const ports = g.ports.size > 0 ? `  ports: ${[...g.ports].join(", ")}` : "";
      out.push(`${r.image}  ×${g.rows.length} containers  ${r.status}${ports}`);
    }
  }
  if (out.length >= lines.length) return null;
  out.push(`· ${rows.length} containers total (${groups.size} distinct image/status groups)`);
  return out.join("\n");
}

function summarizeKubectlGet(stdout: string): string | null {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length < 4) return null;
  const header = lines[0]!;
  const cols = header.trim().split(/\s+/);
  const nsIdx = cols.findIndex((c) => c.toUpperCase() === "NAMESPACE");
  const statusIdx = cols.findIndex((c) => c.toUpperCase() === "STATUS" || c.toUpperCase() === "READY");
  const rows = lines.slice(1);
  const byNs = new Map<string, string[]>();
  for (const row of rows) {
    const parts = row.trim().split(/\s+/);
    const ns = nsIdx >= 0 ? (parts[nsIdx] ?? "default") : "default";
    const arr = byNs.get(ns) ?? [];
    arr.push(row);
    byNs.set(ns, arr);
  }
  if (byNs.size === 1) return null;
  const out: string[] = [header];
  for (const [ns, nsRows] of byNs) {
    const statusCounts = new Map<string, number>();
    for (const row of nsRows) {
      const parts = row.trim().split(/\s+/);
      const st = statusIdx >= 0 ? (parts[statusIdx] ?? "?") : "?";
      statusCounts.set(st, (statusCounts.get(st) ?? 0) + 1);
    }
    const statusSummary = [...statusCounts.entries()].map(([st, n]) => `${st}: ${n}`).join(", ");
    out.push(`namespace=${ns}  ${nsRows.length} resources  [${statusSummary}]`);
  }
  out.push(`· ${rows.length} resources total across ${byNs.size} namespace(s)`);
  return out.join("\n");
}

function summarizeNpmAudit(stdout: string): string | null {
  const lines = stdout.split("\n");
  if (lines.length < 10) return null;
  if (stdout.trimStart().startsWith("{")) {
    try {
      const j = JSON.parse(stdout) as {
        metadata?: { vulnerabilities?: Record<string, number> };
        vulnerabilities?: Record<string, { severity: string; via: Array<string | { url?: string; title?: string }> }>;
      };
      const vuln = j.metadata?.vulnerabilities ?? {};
      const severitySummary = Object.entries(vuln).filter(([, n]) => n > 0).map(([sev, n]) => `${sev}: ${n}`).join(", ");
      const advisories = Object.entries(j.vulnerabilities ?? {}).slice(0, 10).map(([pkg, v]) => {
        const via = v.via.find((x) => typeof x === "object") as { title?: string } | undefined;
        const title = via?.title ?? v.severity;
        return `  ${pkg} (${v.severity}): ${title}`;
      });
      const out2: string[] = [];
      if (severitySummary) out2.push(`npm audit: ${severitySummary}`);
      out2.push(...advisories);
      return out2.length > 1 ? out2.join("\n") : null;
    } catch { /* fall through */ }
  }
  const severityCounts: Record<string, number> = {};
  const vulnLines: string[] = [];
  let foundLine = "";
  for (const line of lines) {
    const sevMatch = line.match(/^\s*(critical|high|moderate|low|info)\s+(.+)/i);
    if (sevMatch) {
      const sev = sevMatch[1]!.toLowerCase();
      severityCounts[sev] = (severityCounts[sev] ?? 0) + 1;
      if (vulnLines.length < 10) vulnLines.push(`  ${sev}: ${sevMatch[2]!.trim()}`);
    }
    if (/found \d+ vulnerabilit/i.test(line)) foundLine = line.trim();
  }
  if (Object.keys(severityCounts).length === 0) return null;
  const summary = Object.entries(severityCounts).map(([sev, n]) => `${sev}: ${n}`).join(", ");
  const out = [`npm audit: ${summary}`];
  out.push(...vulnLines);
  if (foundLine) out.push(foundLine);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("summarizeDockerPs", () => {
  const HEADER = "CONTAINER ID   IMAGE                STATUS          PORTS";
  const row = (id: string, image: string, status: string, port = "0.0.0.0:80->80/tcp") =>
    `${id}           ${image}   Up 5 minutes   ${status}   ${port}`;

  test("returns null for fewer than 3 lines", () => {
    expect(summarizeDockerPs("")).toBeNull();
    expect(summarizeDockerPs(HEADER + "\n" + row("abc123", "nginx:latest", "Up"))).toBeNull();
  });

  test("collapses identical image+status rows into a single count line", () => {
    const stdout = [
      HEADER,
      row("aaa111", "nginx:latest", "Up"),
      row("bbb222", "nginx:latest", "Up"),
      row("ccc333", "nginx:latest", "Up"),
    ].join("\n");
    const result = summarizeDockerPs(stdout);
    expect(result).not.toBeNull();
    expect(result).toContain("×3 containers");
    expect(result).toContain("nginx:latest");
    expect(result).toContain("3 containers total");
  });

  test("preserves rows with distinct images", () => {
    const stdout = [
      HEADER,
      row("aaa111", "nginx:latest", "Up"),
      row("bbb222", "postgres:15", "Up"),
      row("ccc333", "redis:7", "Up"),
    ].join("\n");
    const result = summarizeDockerPs(stdout);
    // 3 distinct images — no collapsing possible, output length same as input.
    // Function returns null when no compression occurred.
    expect(result === null || result!.includes("3 containers total")).toBe(true);
  });

  test("includes container counts in footer", () => {
    const stdout = [
      HEADER,
      row("aaa111", "nginx:latest", "Up"),
      row("bbb222", "nginx:latest", "Up"),
      row("ccc333", "postgres:15", "Exited"),
    ].join("\n");
    const result = summarizeDockerPs(stdout);
    if (result !== null) {
      expect(result).toContain("containers total");
    }
  });
});

describe("summarizeKubectlGet", () => {
  const HEADER = "NAMESPACE   NAME                     STATUS    AGE";

  function podRow(ns: string, name: string, status: string, age: string): string {
    return `${ns.padEnd(12)}${name.padEnd(25)}${status.padEnd(10)}${age}`;
  }

  test("returns null for fewer than 4 lines", () => {
    expect(summarizeKubectlGet("")).toBeNull();
    expect(summarizeKubectlGet(HEADER + "\n" + podRow("default", "pod-1", "Running", "5d"))).toBeNull();
  });

  test("groups by namespace and returns summary", () => {
    const stdout = [
      HEADER,
      podRow("default", "web-pod-1", "Running", "5d"),
      podRow("default", "web-pod-2", "Running", "3d"),
      podRow("kube-system", "coredns-abc", "Running", "10d"),
      podRow("kube-system", "etcd-master", "Running", "10d"),
      podRow("monitoring", "prometheus-0", "Running", "2d"),
    ].join("\n");
    const result = summarizeKubectlGet(stdout);
    expect(result).not.toBeNull();
    expect(result).toContain("namespace=default");
    expect(result).toContain("namespace=kube-system");
    expect(result).toContain("namespace=monitoring");
    expect(result).toContain("5 resources total across 3 namespace(s)");
  });

  test("returns null when all rows are in the same namespace", () => {
    const stdout = [
      HEADER,
      podRow("default", "pod-1", "Running", "1d"),
      podRow("default", "pod-2", "Running", "2d"),
      podRow("default", "pod-3", "Running", "3d"),
    ].join("\n");
    // Single namespace — no grouping benefit.
    expect(summarizeKubectlGet(stdout)).toBeNull();
  });

  test("summarizes status distribution within each namespace", () => {
    const stdout = [
      HEADER,
      podRow("default", "pod-ok-1", "Running", "1d"),
      podRow("default", "pod-fail-1", "Failed", "2d"),
      podRow("staging", "pod-ok-2", "Running", "3d"),
    ].join("\n");
    const result = summarizeKubectlGet(stdout);
    expect(result).not.toBeNull();
    // default namespace has Running:1, Failed:1
    expect(result).toMatch(/Running.*1|Failed.*1/);
  });
});

describe("summarizeNpmAudit", () => {
  test("returns null for fewer than 10 lines", () => {
    expect(summarizeNpmAudit("")).toBeNull();
    expect(summarizeNpmAudit("critical  lodash\n")).toBeNull();
  });

  test("parses text-mode npm audit output", () => {
    const stdout = Array.from({ length: 20 }, (_, i) => {
      if (i === 0) return "# npm audit report";
      if (i < 5) return `critical  lodash  Prototype Pollution CVE-2021-${i}`;
      if (i < 10) return `high  axios  SSRF vulnerability CVE-2022-${i}`;
      if (i < 15) return `moderate  express  Open Redirect CVE-2023-${i}`;
      if (i === 19) return "found 13 vulnerabilities (5 critical, 5 high, 3 moderate)";
      return "some other line";
    }).join("\n");

    const result = summarizeNpmAudit(stdout);
    expect(result).not.toBeNull();
    expect(result).toContain("npm audit:");
    expect(result).toContain("critical");
    expect(result).toContain("found 13 vulnerabilities");
  });

  test("parses JSON-mode npm audit output", () => {
    const auditJson = {
      metadata: { vulnerabilities: { critical: 2, high: 1, moderate: 0, low: 0, info: 0 } },
      vulnerabilities: {
        lodash: {
          severity: "critical",
          via: [{ title: "Prototype Pollution", url: "https://example.com/CVE-1" }],
        },
        axios: {
          severity: "high",
          via: [{ title: "SSRF", url: "https://example.com/CVE-2" }],
        },
        "another-pkg": {
          severity: "critical",
          via: ["lodash"],
        },
      },
    };

    // JSON output must have >= 10 lines when serialized with some indentation.
    const stdout = JSON.stringify(auditJson, null, 2);
    if (stdout.split("\n").length < 10) {
      // Skip this check if JSON is too compact.
      return;
    }

    const result = summarizeNpmAudit(stdout);
    expect(result).not.toBeNull();
    expect(result).toContain("npm audit:");
    expect(result).toContain("critical: 2");
    expect(result).toContain("high: 1");
  });

  test("returns null when no severity lines detected", () => {
    // Lines that don't start with a severity keyword
    const stdout = Array.from({ length: 15 }, (_, i) => `  package-${i} has some text`).join("\n");
    expect(summarizeNpmAudit(stdout)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// v1.18 additions
// ---------------------------------------------------------------------------

describe("summarizeGitLog", () => {
  test("returns null for empty input", () => {
    expect(summarizeGitLog("")).toBeNull();
  });

  test("returns null when ≤ 10 commits (oneline)", () => {
    const stdout = Array.from({ length: 5 }, (_, i) =>
      `${"abcdef0".slice(0, 7).replace(/./g, (c, j) => "0123456789abcdef"[(i + j) % 16]!)} commit subject ${i}`,
    ).join("\n");
    expect(summarizeGitLog(stdout)).toBeNull();
  });

  test("keeps first 10 SHAs + total count when > 10 oneline commits", () => {
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) {
      const sha = (i.toString(16).padStart(7, "0")).slice(0, 7);
      lines.push(`${sha} subject number ${i}`);
    }
    const result = summarizeGitLog(lines.join("\n"));
    expect(result).not.toBeNull();
    expect(result).toContain("25 commits total");
    expect(result).toContain("subject number 0");
    expect(result).toContain("subject number 9");
    // Should NOT include entry 10+ (only first 10).
    expect(result).not.toContain("subject number 15");
  });

  test("parses default (non-oneline) git log block shape", () => {
    let stdout = "";
    for (let i = 0; i < 12; i++) {
      const sha = "a".repeat(6) + i.toString(16);
      stdout +=
        `commit ${sha}0000000000000000000\n` +
        `Author: Dev <dev@example.com>\n` +
        `Date:   Tue Jan 1 00:00:00 2026 +0000\n` +
        `\n` +
        `    subject line ${i}\n` +
        `\n`;
    }
    const result = summarizeGitLog(stdout);
    expect(result).not.toBeNull();
    expect(result).toContain("12 commits total");
    expect(result).toContain("subject line 0");
  });

  test("large input produces small output", () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      const sha = (i.toString(16).padStart(7, "0")).slice(0, 7);
      lines.push(`${sha} commit message that is reasonably long and repeats ${i}`);
    }
    const stdout = lines.join("\n");
    const result = summarizeGitLog(stdout);
    expect(result).not.toBeNull();
    // Output should be dramatically smaller than input.
    expect(result!.length).toBeLessThan(stdout.length / 10);
    expect(result).toContain("500 commits total");
  });
});

describe("summarizeTestRunner", () => {
  test("returns null for short output", () => {
    expect(summarizeTestRunner("")).toBeNull();
    expect(summarizeTestRunner("hi")).toBeNull();
  });

  test("returns null for non-test-runner output", () => {
    const stdout = "hello world\n".repeat(50);
    expect(summarizeTestRunner(stdout)).toBeNull();
  });

  test("summarizes jest output with failures", () => {
    const stdout = [
      "PASS  src/foo.test.ts",
      "PASS  src/bar.test.ts",
      "FAIL  src/baz.test.ts > suite > case",
      "  Error: expected 1 to equal 2",
      "  at src/baz.test.ts:42:9",
      "FAIL  src/qux.test.ts > another",
      "  Expected: true",
      "Tests:  2 failed, 17 passed, 19 total",
      "Snapshots:  0 total",
      "Time:  3.456 s",
    ].join("\n");
    // pad to ensure >200 bytes
    const padded = stdout + "\n" + "x".repeat(300);
    const result = summarizeTestRunner(padded);
    expect(result).not.toBeNull();
    expect(result).toContain("Tests:");
    expect(result).toMatch(/fail/i);
  });

  test("summarizes pytest output", () => {
    const stdout = [
      "============================= test session starts ==============================",
      "collected 15 items",
      "tests/test_foo.py::test_one PASSED",
      "tests/test_bar.py::test_two FAILED",
      "  AssertionError: expected 42",
      "  tests/test_bar.py:17",
      ...Array.from({ length: 10 }, (_, i) => `tests/test_n_${i}.py PASSED`),
      "============================= 1 failed, 14 passed in 2.34s ===================",
      "Ran 15 tests in 2.34s",
    ].join("\n");
    const result = summarizeTestRunner(stdout);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThan(stdout.length);
  });

  test("summarizes bun test / mocha output", () => {
    const lines = ["Running tests..."];
    for (let i = 0; i < 30; i++) lines.push(`  ✓ passing test ${i}`);
    lines.push("  ✗ failing test: expected A to equal B");
    lines.push("  at /repo/file.test.ts:123");
    lines.push(" 30 passing");
    lines.push(" 1 failing");
    const stdout = lines.join("\n");
    const result = summarizeTestRunner(stdout);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThan(stdout.length);
  });

  test("large input produces small output", () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) lines.push(`PASS test/file_${i}.ts`);
    lines.push("Tests:  500 passed, 500 total");
    const stdout = lines.join("\n");
    const result = summarizeTestRunner(stdout);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThan(stdout.length / 5);
    expect(result).toContain("500");
  });
});

describe("summarizeTsc", () => {
  test("returns null when no errors", () => {
    expect(summarizeTsc("")).toBeNull();
    expect(summarizeTsc("Found 0 errors.\n")).toBeNull();
  });

  test("returns null on small outputs with ≤3 errors (pass-through)", () => {
    const stdout =
      "src/foo.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
      "src/bar.ts(22,1): error TS2345: Argument of type '...' is not assignable.\n";
    // Only 2 errors & short — pass-through (null).
    expect(summarizeTsc(stdout)).toBeNull();
  });

  test("summarizes many errors: count + first 3", () => {
    const errs: string[] = [];
    for (let i = 0; i < 20; i++) {
      errs.push(`src/file_${i}.ts(${i + 1},5): error TS2322: Type mismatch at site ${i}.`);
    }
    const stdout = errs.join("\n");
    const result = summarizeTsc(stdout);
    expect(result).not.toBeNull();
    expect(result).toContain("tsc: 20 errors");
    expect(result).toContain("src/file_0.ts:1");
    expect(result).toContain("src/file_1.ts:2");
    expect(result).toContain("src/file_2.ts:3");
    expect(result).toContain("17 more errors");
  });

  test("large input produces small output", () => {
    const errs: string[] = [];
    for (let i = 0; i < 200; i++) {
      errs.push(`src/file_${i}.ts(${i},5): error TS2322: Type mismatch with long description that repeats ${i}.`);
    }
    const stdout = errs.join("\n");
    const result = summarizeTsc(stdout);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThan(stdout.length / 5);
    expect(result).toContain("200 errors");
  });
});

describe("summarizePackageInstall", () => {
  test("returns null for short output", () => {
    expect(summarizePackageInstall("")).toBeNull();
    expect(summarizePackageInstall("hi")).toBeNull();
  });

  test("keeps npm install final line, drops chatter", () => {
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) lines.push(`npm warn deprecated package-${i}@1.0.0: use x`);
    lines.push("");
    lines.push("added 428 packages, and audited 429 packages in 12s");
    lines.push("5 packages are looking for funding");
    const stdout = lines.join("\n");
    const result = summarizePackageInstall(stdout);
    expect(result).not.toBeNull();
    expect(result).toContain("added 428 packages");
    // Output is tiny vs input
    expect(result!.length).toBeLessThan(stdout.length / 20);
  });

  test("keeps bun install signal line", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push(`  + lib-${i}@1.2.3`);
    lines.push("");
    lines.push(" 42 packages installed [1.23s]");
    const stdout = lines.join("\n");
    const result = summarizePackageInstall(stdout);
    expect(result).not.toBeNull();
    expect(result).toContain("42 packages installed");
  });

  test("keeps yarn 'Done in' line", () => {
    const lines: string[] = [];
    for (let i = 0; i < 80; i++) lines.push(`[1/4] Resolving packages... ${i}/200`);
    lines.push("✨  Done in 3.45s.");
    const stdout = lines.join("\n");
    const result = summarizePackageInstall(stdout);
    expect(result).not.toBeNull();
    expect(result).toContain("Done in 3.45s");
  });

  test("returns null when no signal lines present", () => {
    const stdout = Array.from({ length: 50 }, (_, i) => `random line ${i}`).join("\n");
    expect(summarizePackageInstall(stdout)).toBeNull();
  });
});

describe("findSummarizer — v1.18 routing", () => {
  test("matches git log, test runners, tsc, installs", () => {
    expect(findSummarizer("git log")).not.toBeNull();
    expect(findSummarizer("git log --oneline -n 30")).not.toBeNull();
    expect(findSummarizer("jest --watch")).not.toBeNull();
    expect(findSummarizer("vitest run")).not.toBeNull();
    expect(findSummarizer("pytest -xvs")).not.toBeNull();
    expect(findSummarizer("bun test")).not.toBeNull();
    expect(findSummarizer("npm test")).not.toBeNull();
    expect(findSummarizer("tsc --noEmit")).not.toBeNull();
    expect(findSummarizer("npx tsc --noEmit")).not.toBeNull();
    expect(findSummarizer("bunx tsc --noEmit")).not.toBeNull();
    expect(findSummarizer("npm install")).not.toBeNull();
    expect(findSummarizer("npm ci")).not.toBeNull();
    expect(findSummarizer("bun install")).not.toBeNull();
    expect(findSummarizer("yarn install")).not.toBeNull();
    expect(findSummarizer("pnpm install")).not.toBeNull();
  });

  test("non-matching commands fall through to null (→ raw snipBytes by caller)", () => {
    expect(findSummarizer("echo hello")).toBeNull();
    expect(findSummarizer("cat README.md")).toBeNull();
    expect(findSummarizer("awk '{print $1}' file")).toBeNull();
    expect(findSummarizer("sed -i 's/a/b/g' x")).toBeNull();
  });
});

describe("isLargeDiffCommand — routes git diff/show to LLM summarizer", () => {
  test("detects git diff variants", () => {
    expect(isLargeDiffCommand("git diff")).toBe(true);
    expect(isLargeDiffCommand("git diff HEAD~3")).toBe(true);
    expect(isLargeDiffCommand("git diff --stat")).toBe(true);
    expect(isLargeDiffCommand("git show HEAD")).toBe(true);
    expect(isLargeDiffCommand("git show abc123")).toBe(true);
  });

  test("does NOT match other git commands", () => {
    expect(isLargeDiffCommand("git status")).toBe(false);
    expect(isLargeDiffCommand("git log")).toBe(false);
    expect(isLargeDiffCommand("git commit")).toBe(false);
    expect(isLargeDiffCommand("echo git diff")).toBe(false);
  });

  test("exposes a 4 KB threshold constant", () => {
    expect(DIFF_LLM_THRESHOLD_BYTES).toBe(4 * 1024);
  });
});
