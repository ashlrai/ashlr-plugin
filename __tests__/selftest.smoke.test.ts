/**
 * selftest smoke — runs the full probe sweep end-to-end.
 *
 * Covers what unit tests can't: every /ashlr-* command's real entry point plus
 * every ashlr-plugin subcommand, spawned under `bun` against a real fixture
 * repo with an isolated HOME. Slow relative to unit tests (~10s of subprocess
 * spawns) but cheap compared to bench smoke tests.
 */

import { describe, expect, test } from "bun:test";
import { runSelftest } from "../scripts/selftest.ts";

describe("selftest (full sweep)", () => {
  test(
    "every probe passes and every command is accounted for",
    async () => {
      const { report, code } = await runSelftest({});
      expect(code).toBe(0);
      expect(report.status).toBe("ok");
      expect(report.summary.failed).toBe(0);
      expect(report.summary.uncovered).toBe(0);
      // Sanity: the sweep actually exercised the surface.
      expect(report.summary.probes).toBeGreaterThanOrEqual(30);
      expect(report.summary.ok).toBe(report.summary.probes);
      // The JSON envelope carries the selftest kind for machine consumers.
      expect(report.kind).toBe("ashlr.selftest");
      // The MCP probe proves the stdio router works end-to-end.
      const mcp = report.checks.find((c) => c.id === "cli:mcp");
      expect(mcp?.status).toBe("ok");
      expect(mcp?.json).toBe(true);
    },
    { timeout: 180_000 },
  );
});
