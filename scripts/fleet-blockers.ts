#!/usr/bin/env bun
/** Read-only fleet report entry point; keep below Bun's 4 KiB cache threshold.
 * Bun reads its transpiler-cache setting at startup, before evaluating modules.
 * Start the reader with caching disabled so a clean HOME remains untouched.
 */
import { join } from "node:path";

if (import.meta.main) {
  const result = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "lib/fleet-blockers.ts"), ...process.argv.slice(2)],
    { env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  process.exit(result.exitCode);
}

// Library callers retain the same API without changing their cache settings.
export type { FleetBlockers, LaneBlockers } from "./lib/fleet-blockers";
export const { AUTOAUTHOR_STALE_S, fleetBlockers } = await import("./lib/fleet-blockers");
