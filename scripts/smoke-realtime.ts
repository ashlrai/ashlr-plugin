#!/usr/bin/env bun
/**
 * scripts/smoke-realtime.ts
 *
 * Manual QA script — NOT part of `bun test`.
 * Run via:  bun run scripts/smoke-realtime.ts
 *
 * What it does:
 *   1. Records 10 small savings at 100ms intervals via recordSaving.
 *   2. After each, calls buildStatusLine() and prints the extracted
 *      session/lifetime numbers.
 *   3. Asserts each recorded saving shows up in the subsequent status-line
 *      read within 500ms.
 *   4. Demonstrates the cross-terminal session isolation invariant:
 *      - Two fake session IDs (SMOKE_A / SMOKE_B) each record savings.
 *      - Session counter stays isolated; lifetime is shared.
 *
 * Exit 0 on pass, 1 on failure.
 */

import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir, homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Setup: isolated home directory so we don't pollute ~/.ashlr during QA.
// ---------------------------------------------------------------------------

const smokeHome = await mkdtemp(join(tmpdir(), "ashlr-smoke-"));
await mkdir(join(smokeHome, ".ashlr"), { recursive: true });

// Override HOME so _stats.ts writes to our sandbox.
const realHome = process.env.HOME;
process.env.HOME = smokeHome;
// Use debounce mode (no ASHLR_STATS_SYNC) to exercise the real path.
delete process.env.ASHLR_STATS_SYNC;

// Dynamic imports AFTER setting HOME so module-level statsPath() picks it up.
const { recordSaving, _drainWrites, _resetMemCache } = await import("../servers/_stats.ts");
const { buildStatusLine, _resetReadCache } = await import("../scripts/savings-status-line.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_ENV: NodeJS.ProcessEnv = {
  NO_COLOR: "1",
  ASHLR_STATUS_ANIMATE: "0",
  COLUMNS: "120",
  HOME: smokeHome,
};

function statusNumbers(sessionId: string): { session: number; lifetime: number; raw: string } {
  _resetReadCache();
  const env = { ...BASE_ENV, CLAUDE_SESSION_ID: sessionId };
  const line = buildStatusLine({ home: smokeHome, env });
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");

  function parseTokens(seg: string): number {
    const m = seg.match(/([\d.]+)([KM]?)/);
    if (!m) return 0;
    const v = parseFloat(m[1]!);
    if (m[2] === "K") return Math.round(v * 1000);
    if (m[2] === "M") return Math.round(v * 1_000_000);
    return Math.round(v);
  }

  const sessMatch = plain.match(/session [↑+]?\+([^\s·]+)/);
  const lifeMatch = plain.match(/lifetime \+([^\s·]+)/);
  return {
    session:  sessMatch  ? parseTokens(sessMatch[1]!) : 0,
    lifetime: lifeMatch  ? parseTokens(lifeMatch[1]!) : 0,
    raw: plain,
  };
}

function pass(msg: string) { console.log(`  ✓ ${msg}`); }
function fail(msg: string) { console.error(`  ✗ FAIL: ${msg}`); failures++; }

let failures = 0;

// ---------------------------------------------------------------------------
// Phase 1: 10 savings at 100ms intervals, verify each shows up within 500ms
// ---------------------------------------------------------------------------

const SID_MAIN = "smoke-main";
process.env.CLAUDE_SESSION_ID = SID_MAIN;

console.log("\n=== Phase 1: 10 savings × 100ms intervals ===\n");

// Track cumulative expected tokens (each call saves ceil((4000-400)/4) = 900).
const SAVE_TOKENS_PER_CALL = Math.ceil((4_000 - 400) / 4); // 900

for (let i = 1; i <= 10; i++) {
  const t0 = Date.now();
  await recordSaving(4_000, 400, "ashlr__read");

  // Poll until visible or 500ms timeout.
  const expected = i * SAVE_TOKENS_PER_CALL;
  let visible = false;
  const deadline = t0 + 500;

  while (Date.now() < deadline) {
    const { session, lifetime, raw } = statusNumbers(SID_MAIN);
    if (session >= expected && lifetime >= expected) {
      const elapsed = Date.now() - t0;
      console.log(`  [${i}/10] session=${session} lifetime=${lifetime}  (visible in ${elapsed}ms)`);
      console.log(`          status: ${raw}`);
      visible = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }

  if (!visible) {
    const { session, lifetime } = statusNumbers(SID_MAIN);
    fail(`saving #${i}: expected session≥${expected}, got session=${session} lifetime=${lifetime} after 500ms`);
  } else {
    pass(`saving #${i} visible within 500ms`);
  }

  // Small gap between calls.
  await new Promise((r) => setTimeout(r, 100));
}

// ---------------------------------------------------------------------------
// Phase 2: Cross-terminal invariant
// ---------------------------------------------------------------------------

console.log("\n=== Phase 2: cross-terminal session isolation ===\n");

const SID_A = "smoke-terminal-A";
const SID_B = "smoke-terminal-B";

// Reset to a fresh sandbox home for clean counting.
_resetMemCache();
const crossHome = await mkdtemp(join(tmpdir(), "ashlr-smoke-cross-"));
await mkdir(join(crossHome, ".ashlr"), { recursive: true });
process.env.HOME = crossHome;
_resetMemCache();
_resetReadCache();

// Terminal A records 3 savings.
await recordSaving(8_000, 800, "ashlr__read", { sessionId: SID_A });
await recordSaving(8_000, 800, "ashlr__read", { sessionId: SID_A });
await recordSaving(8_000, 800, "ashlr__read", { sessionId: SID_A });
// Terminal B records 2 savings.
await recordSaving(8_000, 800, "ashlr__read", { sessionId: SID_B });
await recordSaving(8_000, 800, "ashlr__read", { sessionId: SID_B });

// Drain so everything is on disk.
await _drainWrites();
_resetMemCache();

const PER_CALL = Math.ceil((8_000 - 800) / 4); // 1800

const envBase: NodeJS.ProcessEnv = { ...BASE_ENV, HOME: crossHome };

_resetReadCache();
const aView = (() => {
  const env = { ...envBase, CLAUDE_SESSION_ID: SID_A };
  const line = buildStatusLine({ home: crossHome, env });
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  const sessMatch = plain.match(/session [↑+]?\+([^\s·]+)/);
  const lifeMatch = plain.match(/lifetime \+([^\s·]+)/);
  function pt(s: string): number {
    const m = s.match(/([\d.]+)([KM]?)/);
    if (!m) return 0;
    const v = parseFloat(m[1]!);
    if (m[2] === "K") return Math.round(v * 1000);
    if (m[2] === "M") return Math.round(v * 1_000_000);
    return Math.round(v);
  }
  return { session: sessMatch ? pt(sessMatch[1]!) : 0, lifetime: lifeMatch ? pt(lifeMatch[1]!) : 0, raw: plain };
})();

_resetReadCache();
const bView = (() => {
  const env = { ...envBase, CLAUDE_SESSION_ID: SID_B };
  const line = buildStatusLine({ home: crossHome, env });
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  const sessMatch = plain.match(/session [↑+]?\+([^\s·]+)/);
  const lifeMatch = plain.match(/lifetime \+([^\s·]+)/);
  function pt(s: string): number {
    const m = s.match(/([\d.]+)([KM]?)/);
    if (!m) return 0;
    const v = parseFloat(m[1]!);
    if (m[2] === "K") return Math.round(v * 1000);
    if (m[2] === "M") return Math.round(v * 1_000_000);
    return Math.round(v);
  }
  return { session: sessMatch ? pt(sessMatch[1]!) : 0, lifetime: lifeMatch ? pt(lifeMatch[1]!) : 0, raw: plain };
})();

console.log(`  Terminal A view: session=${aView.session}  lifetime=${aView.lifetime}`);
console.log(`    status: ${aView.raw}`);
console.log(`  Terminal B view: session=${bView.session}  lifetime=${bView.lifetime}`);
console.log(`    status: ${bView.raw}`);

// A's session = 3 × PER_CALL; B sees 0 for A's session.
if (aView.session >= 3 * PER_CALL) {
  pass(`terminal A session correct (≥${3 * PER_CALL}, got ${aView.session})`);
} else {
  fail(`terminal A session expected ≥${3 * PER_CALL}, got ${aView.session}`);
}

if (bView.session >= 2 * PER_CALL) {
  pass(`terminal B session correct (≥${2 * PER_CALL}, got ${bView.session})`);
} else {
  fail(`terminal B session expected ≥${2 * PER_CALL}, got ${bView.session}`);
}

// Both should see the same lifetime (5 calls total).
if (aView.lifetime >= 5 * PER_CALL && bView.lifetime >= 5 * PER_CALL) {
  pass(`both terminals see combined lifetime (≥${5 * PER_CALL})`);
} else {
  fail(`lifetime mismatch: A=${aView.lifetime} B=${bView.lifetime} expected ≥${5 * PER_CALL}`);
}

// A's session tokens should NOT appear in B's session bucket.
if (bView.session < aView.session) {
  pass(`terminal B session (${bView.session}) < terminal A session (${aView.session}) — isolation confirmed`);
} else {
  fail(`session isolation broken: B.session=${bView.session} should be < A.session=${aView.session}`);
}

// ---------------------------------------------------------------------------
// Cleanup & result
// ---------------------------------------------------------------------------

await rm(smokeHome, { recursive: true, force: true });
await rm(crossHome, { recursive: true, force: true });
// Restore real HOME.
if (realHome) process.env.HOME = realHome;

console.log("");
if (failures === 0) {
  console.log("All smoke checks passed.\n");
  process.exit(0);
} else {
  console.error(`${failures} smoke check(s) FAILED.\n`);
  process.exit(1);
}
