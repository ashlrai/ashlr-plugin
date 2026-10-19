/**
 * scripts/_read-thresholds.ts
 *
 * Report-only threshold recommendations for scripts/bench-read-real.ts.
 * Pure functions: no I/O, no defaults changed anywhere. The bench prints the
 * result next to the current defaults so a human can decide.
 *
 * Derivation (break-even by size bin):
 *   1. Put each file in a fixed-width byte bin (default 256 bytes).
 *   2. Ignore bins with fewer than `minFiles` files (default 3) as too sparse.
 *   3. A bin "wins" when its aggregate candidate tokens are no more than its
 *      aggregate baseline tokens.
 *   4. The recommendation is the lower edge of the earliest qualified bin from
 *      which every qualified bin upward wins. If the largest qualified bin
 *      loses, there is no recommendation.
 *   5. If the very first qualified bin already wins, the data cannot see the
 *      true break-even, so the result is marked as bounded by the smallest
 *      sampled size ("at or below").
 */

export interface ReadSample {
  /** File size in bytes. */
  bytes: number;
  /** Baseline tokens (raw file, or the snip view for the AST comparison). */
  baseline: number;
  /** Candidate tokens (ashlr__read output, or the AST view). */
  candidate: number;
}

export interface BinStat {
  /** Inclusive lower edge in bytes. */
  from: number;
  files: number;
  baseline: number;
  candidate: number;
  wins: boolean;
}

export interface BreakEven {
  /** Recommended threshold in bytes, or null when no size range reliably wins. */
  bytes: number | null;
  /** True when the first qualified bin already wins (true break-even may be lower). */
  atOrBelow: boolean;
  samples: number;
  qualifiedBins: number;
  bins: BinStat[];
}

export interface BreakEvenOptions {
  binBytes?: number;
  minFiles?: number;
}

export function deriveBreakEven(samples: ReadSample[], opts: BreakEvenOptions = {}): BreakEven {
  const binBytes = opts.binBytes ?? 256;
  const minFiles = opts.minFiles ?? 3;
  const byBin = new Map<number, BinStat>();
  for (const s of samples) {
    if (!Number.isFinite(s.bytes) || s.bytes < 0) continue;
    const from = Math.floor(s.bytes / binBytes) * binBytes;
    const bin = byBin.get(from) ?? { from, files: 0, baseline: 0, candidate: 0, wins: false };
    bin.files++;
    bin.baseline += s.baseline;
    bin.candidate += s.candidate;
    byBin.set(from, bin);
  }
  const bins = [...byBin.values()].sort((a, b) => a.from - b.from);
  for (const b of bins) b.wins = b.candidate <= b.baseline;
  const qualified = bins.filter((b) => b.files >= minFiles);
  let start = qualified.length;
  while (start > 0 && qualified[start - 1]!.wins) start--;
  const found = start < qualified.length;
  return {
    bytes: found ? qualified[start]!.from : null,
    atOrBelow: found && start === 0,
    samples: samples.length,
    qualifiedBins: qualified.length,
    bins,
  };
}

export interface ThresholdReport {
  name: string;
  current: number;
  derivation: string;
  result: BreakEven;
}

function describe(r: BreakEven): string {
  if (r.bytes === null) return "none (no size range where every bin breaks even)";
  return r.atOrBelow ? `<= ${r.bytes} B (wins from the smallest sampled bin)` : `${r.bytes} B`;
}

/** Lines the bench prints. Always states that defaults are unchanged. */
export function formatThresholdReport(
  reports: ThresholdReport[],
  ctx: { every: number; binBytes: number; minFiles: number },
): string[] {
  const out: string[] = [];
  out.push("");
  out.push("Recommended read thresholds (report only, no default is changed)");
  for (const r of reports) {
    out.push(
      `  ${r.name.padEnd(22)} current ${String(r.current).padStart(5)} B   recommended ${describe(r.result)}`,
    );
    out.push(
      `    from ${r.result.samples} files, ${r.result.qualifiedBins} bins with >= ${ctx.minFiles} files; ${r.derivation}`,
    );
  }
  out.push(
    `  How: ${ctx.binBytes} B size bins; the threshold is the lower edge of the first bin from which every bin`,
  );
  out.push("  with enough files has candidate tokens <= baseline tokens.");
  out.push(
    `  Caveat: derived from this repo's own tracked files (every Nth file, N=${ctx.every}) with estimated tokens,`,
  );
  out.push("  not a real tokenizer. Synthetic; other codebases will differ. Review before changing any default.");
  return out;
}
