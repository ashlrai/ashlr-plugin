/**
 * v1.30 #8/#9 — fixture-based tests for the new bash summarizers.
 *
 * Asserts: realistic input → smaller output, critical signal preserved,
 * small input returns null (don't waste tokens on already-small payloads).
 */

import { describe, expect, test } from "bun:test";

import {
  findSummarizer,
  summarizeDockerLogs,
  summarizeDockerStats,
  summarizeGhPrList,
  summarizeGhPrView,
} from "../servers/_bash-summarizers-registry";

// ---------------------------------------------------------------------------
// docker logs
// ---------------------------------------------------------------------------

describe("summarizeDockerLogs", () => {
  test("returns null on small input (< 40 lines)", () => {
    const small = Array(20).fill("2026-01-01 12:00:00 INFO request handled").join("\n");
    expect(summarizeDockerLogs(small)).toBeNull();
  });

  test("compresses a large log to head + tail + error extraction", () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      if (i === 50) lines.push("2026-01-01 12:00:50 ERROR connection refused");
      else if (i === 120) lines.push("2026-01-01 12:02:00 FATAL out of memory");
      else lines.push(`2026-01-01 12:00:${i.toString().padStart(2, "0")} INFO request ${i}`);
    }
    const stdout = lines.join("\n");
    const result = summarizeDockerLogs(stdout)!;
    expect(result).not.toBeNull();
    expect(result.length).toBeLessThan(stdout.length);

    // Critical: both error lines survived.
    expect(result).toContain("ERROR connection refused");
    expect(result).toContain("FATAL out of memory");
    // Tail preserved (last log line should be in there).
    expect(result).toContain("request 199");
  });

  test("registry routes 'docker logs <container>' to this summarizer", () => {
    expect(findSummarizer("docker logs my-app")).toBe(summarizeDockerLogs);
  });
});

// ---------------------------------------------------------------------------
// docker stats
// ---------------------------------------------------------------------------

describe("summarizeDockerStats", () => {
  test("returns null on small output", () => {
    const small = [
      "CONTAINER   CPU%   MEM USAGE       MEM%   NET I/O",
      "abc123      1.2%   100MiB/1GiB     10.0%  500B/200B",
      "def456      0.5%   50MiB/1GiB      5.0%   200B/100B",
    ].join("\n");
    expect(summarizeDockerStats(small)).toBeNull();
  });

  test("compresses a large stats output to top-by-CPU and top-by-MEM rows", () => {
    const lines: string[] = ["CONTAINER   CPU%   MEM USAGE       MEM%   NET I/O"];
    for (let i = 0; i < 30; i++) {
      const cpu = (i * 3).toFixed(1);
      const mem = (i * 2).toFixed(1);
      lines.push(`container-${i}  ${cpu}%  ${i * 10}MiB/1GiB  ${mem}%  500B/200B`);
    }
    const stdout = lines.join("\n");
    const result = summarizeDockerStats(stdout)!;
    expect(result).not.toBeNull();
    expect(result.length).toBeLessThan(stdout.length);

    // The highest CPU container should be present.
    expect(result).toContain("container-29");
    // The footer counts total.
    expect(result).toContain("30 containers total");
  });

  test("registry routes 'docker stats --no-stream' to this summarizer", () => {
    expect(findSummarizer("docker stats --no-stream")).toBe(summarizeDockerStats);
  });
});

// ---------------------------------------------------------------------------
// gh pr list
// ---------------------------------------------------------------------------

describe("summarizeGhPrList", () => {
  test("returns null on small list (≤ 12 lines)", () => {
    const small = Array(8)
      .fill(0)
      .map((_, i) => `${i}\tTitle ${i}\tbranch-${i}\tOPEN`)
      .join("\n");
    expect(summarizeGhPrList(small)).toBeNull();
  });

  test("compresses a large PR list to state-pivot + first 10 rows", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      const state = i % 3 === 0 ? "MERGED" : i % 3 === 1 ? "OPEN" : "CLOSED";
      lines.push(`#${i}\tFeature ${i}\tfeat-${i}\t${state}`);
    }
    const stdout = lines.join("\n");
    const result = summarizeGhPrList(stdout)!;
    expect(result).not.toBeNull();
    expect(result.length).toBeLessThan(stdout.length);

    // State pivot present.
    expect(result).toMatch(/OPEN: \d+/);
    expect(result).toMatch(/MERGED: \d+/);
    expect(result).toContain("50 rows");
    // First 10 rows present (rows 0-9).
    expect(result).toContain("Feature 0\t");
    expect(result).toContain("Feature 9\t");
    // Tail elision marker.
    expect(result).toMatch(/40 rows elided/);
  });

  test("registry routes 'gh pr list' and 'gh issue list' to this summarizer", () => {
    expect(findSummarizer("gh pr list")).toBe(summarizeGhPrList);
    expect(findSummarizer("gh issue list")).toBe(summarizeGhPrList);
  });
});

// ---------------------------------------------------------------------------
// gh pr view
// ---------------------------------------------------------------------------

describe("summarizeGhPrView", () => {
  test("returns null on small PR view (< 60 lines)", () => {
    const small = ["title:\tFix login bug", "state:\tOPEN", "body:", "Fixes a small issue."]
      .concat(Array(20).fill("more context line"))
      .join("\n");
    expect(summarizeGhPrView(small)).toBeNull();
  });

  test("compresses a long PR view to header + comment count + recent comments", () => {
    const header = [
      "title:\tBig refactor of auth module",
      "state:\tOPEN",
      "author:\tmasonwyatt",
      "branch:\tfeat/refactor-auth",
      "base:\tmain",
      "body:",
      "## Summary",
      "Refactors the auth module to use new session token format.",
      "",
      "## Test plan",
      ...Array(15).fill("- [ ] check this thing"),
    ];
    const comments: string[] = [];
    for (let i = 0; i < 8; i++) {
      comments.push("--");
      comments.push(`@reviewer${i} commented`);
      comments.push("");
      comments.push(...Array(8).fill(`Comment ${i} body line`));
    }
    const stdout = [...header, ...comments].join("\n");
    const result = summarizeGhPrView(stdout)!;
    expect(result).not.toBeNull();
    expect(result.length).toBeLessThan(stdout.length);

    // Header preserved.
    expect(result).toContain("Big refactor of auth module");
    expect(result).toContain("state:");
    // Comment count surfaced.
    expect(result).toMatch(/\d+ comments?/);
    // Latest comment block in the tail.
    expect(result).toContain("@reviewer7");
  });

  test("registry routes 'gh pr view 123' and 'gh issue view 456' to this summarizer", () => {
    expect(findSummarizer("gh pr view 123")).toBe(summarizeGhPrView);
    expect(findSummarizer("gh issue view 456")).toBe(summarizeGhPrView);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: routing precedence
// ---------------------------------------------------------------------------

describe("v1.30 registry routing", () => {
  test("3-word keys (gh-pr-list) beat 2-word keys (gh-pr) when both could match", () => {
    // We don't define 2-word gh-pr — so the 3-word should hit.
    expect(findSummarizer("gh pr list --state=open")).toBe(summarizeGhPrList);
  });

  test("docker-ps is unchanged after our additions (no regression in existing routes)", () => {
    const fn = findSummarizer("docker ps -a");
    expect(fn).not.toBeNull();
    // Just confirm it returns SOMETHING — exact identity tested in existing suite.
  });

  test("unknown commands return null (no false routes)", () => {
    expect(findSummarizer("some-random-tool subcommand")).toBeNull();
  });
});
