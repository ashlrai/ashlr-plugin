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
        "TODO: real-LLM mode dwarfs these numbers — any API call >100ms, see docs/operations.md",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
