import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("orchestration benchmark real-LLM limitation", () => {
  test("includes the limitation in the generated formatted report", () => {
    const home = mkdtempSync(join(tmpdir(), "bench-note-"));
    try {
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, "..", "scripts", "bench-orchestrate.ts"), "--iterations", "1"],
        {
          encoding: "utf8",
          timeout: 30_000,
          // No inherited credentials, telemetry consent, or real-LLM flag.
          env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Orchestrator overhead bench (stub mode, 1 iterations each)");
      expect(result.stdout).toContain("chain-3");
      expect(result.stdout).toContain(
        "these numbers exclude real-LLM latency; model API calls are outside what this local stub benchmark measures",
      );
      expect(result.stdout).toContain(
        "TODO: real-LLM mode dwarfs these numbers — any API call >100ms, see docs/operations.md",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("includes the limitation alongside measured timings in generated JSON", () => {
    const home = mkdtempSync(join(tmpdir(), "bench-note-"));
    try {
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, "..", "scripts", "bench-orchestrate.ts"), "--iterations", "1", "--json"],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.mode).toBe("stub");
      expect(report.shapes.length).toBeGreaterThan(0);
      expect(typeof report.shapes[0].wallclock_median_ms).toBe("number");
      expect(report.warning).toContain("exclude real-LLM latency");
      expect(report.warning).toContain("model API calls are outside what this local stub benchmark measures");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
