/**
 * End-to-end smoke test for /ashlr-orchestrate.
 *
 * Spawns scripts/cli-orchestrate.ts as a real bun subprocess with
 * ASHLR_TEST_TIER=pro injected so we don't need a real Pro token cache.
 * Asserts:
 *   - exit code 0
 *   - stdout contains the goal echoed in the render
 *   - stdout contains at least one node id (explore / implement / verify)
 *   - stdout contains "completed"
 *
 * Uses --dry-run + --auto-confirm so no real subagents spawn and no
 * stdin interaction is needed.
 */

import { describe, expect, test } from "bun:test";
import { join } from "path";
import { spawnSync } from "child_process";

describe("cli-orchestrate smoke", () => {
  test("dry-run + auto-confirm prints render + completed sentinel", () => {
    const script = join(import.meta.dir, "..", "scripts", "cli-orchestrate.ts");
    const result = spawnSync(
      "bun",
      [
        script,
        "smoke goal — refactor servers",
        "--scope",
        "./servers",
        "--tier",
        "pro",
        "--auto-confirm",
        "--dry-run",
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          ASHLR_TEST_TIER: "pro",
        },
      },
    );
    expect(result.status).toBe(0);
    const out = result.stdout;
    expect(out).toContain("smoke goal");
    // Track A's expander emits `node-<module>` ids, one per discovered scope module.
    expect(/\bnode-\S+/.test(out)).toBe(true);
    expect(out).toContain("Orchestration plan");
    expect(out).toContain("completed");
  });
});
