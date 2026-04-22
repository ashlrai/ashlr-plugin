#!/usr/bin/env bun
/**
 * ashlr SessionEnd hook: stats bucket GC.
 *
 * When a Claude Code session ends, drop its per-session bucket from
 * ~/.ashlr/stats.json so the `sessions` map doesn't grow unboundedly as
 * sessions come and go. Lifetime counters are preserved — only the
 * session-scoped totals are removed.
 *
 * Also appends one final line to ~/.ashlr/session-log.jsonl capturing the
 * totals from the bucket we're dropping, so the log remains a complete
 * audit trail even after the bucket is gone.
 *
 * Contract: never throws, always exits 0, never blocks the shell for more
 * than a few hundred ms.
 */

import { appendFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

import { currentSessionId, dropSessionBucket } from "../servers/_stats";
import { maybeSyncToCloud as maybeSyncNudgeEvents, recordNudgeDismissedIfPending } from "../servers/_nudge-events";

const DEADLINE_MS = 800;

async function main(): Promise<void> {
  const sessionId = currentSessionId();
  // Drain stdin defensively; the hook payload is unused here.
  try {
    if (!process.stdin.isTTY) {
      await Promise.race([
        (async () => {
          for await (const _ of process.stdin as AsyncIterable<unknown>) { /* discard */ }
        })(),
        new Promise((r) => setTimeout(r, 50)),
      ]);
    }
  } catch { /* ignore */ }

  // Emit implicit-dismissal telemetry if a nudge was shown this session but
  // never clicked. Best-effort; never blocks the GC path.
  try {
    await Promise.race([
      recordNudgeDismissedIfPending(),
      new Promise((r) => setTimeout(r, 200)),
    ]);
    maybeSyncNudgeEvents();
  } catch { /* telemetry is decoration */ }

  try {
    const dropped = await Promise.race([
      dropSessionBucket(sessionId),
      new Promise<null>((r) => setTimeout(() => r(null), DEADLINE_MS)),
    ]);
    if (dropped) {
      const summary = {
        ts: new Date().toISOString(),
        agent: "claude-code",
        event: "session_end",
        tool: "ashlr__session",
        session: sessionId,
        calls: dropped.calls,
        tokens_saved: dropped.tokensSaved,
        started_at: dropped.startedAt,
      };
      const logPath = join(process.env.HOME ?? homedir(), ".ashlr", "session-log.jsonl");
      try { await appendFile(logPath, JSON.stringify(summary) + "\n"); } catch { /* best-effort */ }
    }
  } catch { /* GC is decoration — never break session-end */ }
}

if (import.meta.main) {
  await main();
  process.exit(0);
}
