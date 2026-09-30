/**
 * timing-budget.ts — scale wall-clock test budgets on shared CI runners.
 *
 * Several tests and smoke checks assert latency bounds (e.g. router cold start
 * < 300ms). Those bounds are calibrated on a developer machine. GitHub-hosted
 * macOS runners are much slower and noisier: the same unchanged code has
 * measured ~450ms median cold start there, failing required checks on PRs
 * that touch no code.
 *
 * `timingBudgetMs(ms)` returns `ms` unchanged locally, so local perf checks
 * keep their original strength, and scales it on CI:
 *   - `ASHLR_TIMING_MULTIPLIER=<n>` (n >= 1) always wins, locally or on CI;
 *   - otherwise, when `CI` is set: 3x on macOS, 2x elsewhere.
 * Windows-specific budgets that are already loosened should stay as they are
 * and not be passed through this helper.
 */

export function timingMultiplier(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): number {
  const explicit = Number(env.ASHLR_TIMING_MULTIPLIER);
  if (Number.isFinite(explicit) && explicit >= 1) return explicit;
  const ci = env.CI;
  if (!ci || ci === "0" || ci.toLowerCase() === "false") return 1;
  return platform === "darwin" ? 3 : 2;
}

export function timingBudgetMs(
  ms: number,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): number {
  return Math.round(ms * timingMultiplier(env, platform));
}
