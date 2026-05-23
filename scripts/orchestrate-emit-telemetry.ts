/**
 * orchestrate-emit-telemetry.ts — Q1'27 plugin emit for orchestration runs.
 *
 * Called by scripts/orchestrate-run.ts AFTER runTaskGraph() returns, but
 * before the result is handed back to the caller. Best-effort: never blocks
 * the return, never throws, never leaks identity content into logs.
 *
 * Wire format mirrors the server zod schema in
 * server/src/routes/orchestration-runs.ts.
 *
 * Privacy gate: ONLY fires when telemetry consent is on (~/.ashlr/config.json
 * :: { telemetry: "opt-in" } OR ASHLR_TELEMETRY=on). When consent is off,
 * this function is a no-op — no fetch, no DNS, no work.
 *
 * Network behavior: 5s timeout via AbortSignal.timeout, fire-and-forget on
 * failure (same fetch pattern as emitDailyHeartbeat in servers/_telemetry.ts).
 *
 * Test seams: _setOrchestrationTelemetryUrl + _setOrchestrationTelemetryFetch
 * follow the existing _setDailyHeartbeat* pattern so the runner integration
 * test can assert "emit fired with this body" without hitting the network.
 */

import { getIdentityHash } from "../servers/_identity-hash.ts";
import { isTelemetryEnabled } from "../servers/_telemetry.ts";
import type { TaskGraph } from "../servers/_task-graph.ts";
import type { RunResult } from "./orchestrate-run.ts";

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

let _urlOverride: string | null = null;
let _fetchOverride: typeof fetch | null = null;
let _isTelemetryOverride: (() => boolean) | null = null;

/** @internal — tests force POSTs to a mock URL. */
export function _setOrchestrationTelemetryUrl(url: string | null): void {
  _urlOverride = url;
}

/** @internal — tests inject a fake fetch so they can capture calls. */
export function _setOrchestrationTelemetryFetch(fn: typeof fetch | null): void {
  _fetchOverride = fn;
}

/** @internal — tests skip the consent check. */
export function _setIsTelemetryEnabledForOrchestrationEmit(
  fn: (() => boolean) | null,
): void {
  _isTelemetryOverride = fn;
}

function isTelemetryGuarded(): boolean {
  return _isTelemetryOverride ? _isTelemetryOverride() : isTelemetryEnabled();
}

// ---------------------------------------------------------------------------
// URL resolution — matches the daily-heartbeat pattern.
// ---------------------------------------------------------------------------

function endpointUrl(): string {
  if (_urlOverride) return _urlOverride;
  const base = process.env["ASHLR_API_URL"] ?? "https://api.ashlr.ai";
  return `${base.replace(/\/+$/, "")}/v1/orchestration-runs`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OrchestrationRunTelemetryPayload {
  identity_hash:    string;
  github_hash:      string | null;
  graph_id:         string;
  goal:             string;
  tier:             "pro" | "team";
  mode:             "stub" | "real-llm";
  started_at:       string;
  finished_at:      string;
  duration_ms:      number;
  node_count:       number;
  fail_count:       number;
  ok:               boolean;
  total_tokens_in:  number;
  total_tokens_out: number;
}

/**
 * Build the wire payload from a RunResult + TaskGraph + mode flag.
 *
 * Pure function — easy to unit-test without network. Exported so the runner
 * integration test can verify shape without invoking the full fetch path.
 */
export function buildOrchestrationRunPayload(
  result: RunResult,
  graph: TaskGraph,
  mode: "stub" | "real-llm",
): OrchestrationRunTelemetryPayload {
  const { machineHash, githubHash } = getIdentityHash();

  // tier on the graph is "pro" | "team" — free is gated client-side, so a
  // free-tier reject result never reaches us. We coerce defensively to
  // satisfy the wire enum if a future caller mis-routes us.
  const tier: "pro" | "team" = graph.tier === "team" ? "team" : "pro";

  // Token totals: today the runner only tracks one running total. The wire
  // schema accommodates input vs output separately for future LLM-mode
  // wiring; in stub mode we account all tokens as "in" (the dominant
  // cost in real Claude usage), leaving "out" at 0.
  const totalTokens = typeof result.totalTokensUsed === "number"
    ? result.totalTokensUsed
    : (result.totalTokens ?? 0);

  const failCount = (result.nodeResults ?? []).filter((n) => !n.ok).length;

  return {
    identity_hash:    machineHash,
    github_hash:      githubHash,
    graph_id:         result.graphId ?? graph.id,
    goal:             graph.goal,
    tier,
    mode,
    started_at:       result.startedAt,
    finished_at:      result.finishedAt,
    duration_ms:      result.totalDurationMs,
    node_count:       (result.nodeResults ?? []).length,
    fail_count:       failCount,
    ok:               result.ok,
    total_tokens_in:  totalTokens,
    total_tokens_out: 0,
  };
}

/**
 * Fire-and-forget POST of an orchestration-run telemetry record.
 *
 * Guarantees:
 *   - Returns immediately on the success path (Promise resolves; network
 *     call dispatched in background).
 *   - Silent on every error path — never breaks the runner return.
 *   - No-op when telemetry consent is off.
 *
 * The runner calls this from runTaskGraph() right before returning. We
 * await this call so tests can assert "the POST fired," but the underlying
 * fetch uses AbortSignal.timeout(5000) and the catch swallows failures,
 * so the actual network round-trip never blocks the caller.
 */
export async function emitOrchestrationRunTelemetry(
  result: RunResult,
  graph: TaskGraph,
  mode: "stub" | "real-llm",
): Promise<void> {
  try {
    if (!isTelemetryGuarded()) return;

    const payload = buildOrchestrationRunPayload(result, graph, mode);
    const url = endpointUrl();
    const fetcher = _fetchOverride ?? globalThis.fetch;

    // Fire-and-forget: kick off the fetch, don't await it. We DO want errors
    // swallowed so a flaky network never breaks the runner.
    void Promise.resolve()
      .then(() =>
        fetcher(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5_000),
        }),
      )
      .catch(() => {
        /* network failure — drop silently, same as emitDailyHeartbeat */
      });
  } catch {
    /* never propagate — telemetry must never break orchestrate-run */
  }
}
