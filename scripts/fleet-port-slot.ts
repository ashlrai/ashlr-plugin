#!/usr/bin/env bun
/** bun scripts/fleet-port-slot.ts [worktree]
 * Derives a stable per-worktree slot — a high port and a data directory —
 * from a worktree path, so parallel checkouts can run fleet tooling without
 * colliding on the shared defaults. The same path always yields the same
 * slot; distinct paths yield distinct slots.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface FleetSlot {
  port: number;
  dataDir: string;
}

// IANA dynamic/private range. Only even ports are handed out, so the share
// server (slot port + 1) can never collide with another worktree's UI port.
export const FLEET_PORT_BASE = 49152;
export const FLEET_PORT_SLOTS = 8192; // 49152, 49154, ... 65534 — +1 stays valid.

/** Canonical slot key: the real path when it exists, the resolved path otherwise. */
const canonical = (worktree: string): string => {
  try {
    return realpathSync(worktree);
  } catch {
    return resolve(worktree);
  }
};

/** Stable slot for a worktree path. The data dir lives under ~/.ashlr-worktrees/, a sibling of ~/.ashlr and ~/.ashlr-runs. */
export function fleetPortSlot(worktree: string, home: string = homedir()): FleetSlot {
  const dir = canonical(worktree);
  const hex = createHash("sha256").update(dir).digest("hex");
  return {
    port: FLEET_PORT_BASE + 2 * (parseInt(hex.slice(0, 8), 16) % FLEET_PORT_SLOTS),
    dataDir: join(home, ".ashlr-worktrees", `${basename(dir) || "worktree"}-${hex.slice(0, 12)}`),
  };
}

/** The port a caller should bind: an explicit port always wins over the derived slot. */
export function fleetUiPort(explicit: number | undefined, worktree: string, home?: string): number {
  return explicit ?? fleetPortSlot(worktree, home).port;
}

if (import.meta.main) console.log(JSON.stringify(fleetPortSlot(process.argv[2] ?? process.cwd())));
