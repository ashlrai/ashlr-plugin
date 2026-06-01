/**
 * /benchmarks — Reproducible benchmark results page.
 *
 * Server component. Reads docs/benchmarks-v2.json at build time.
 * Falls back to null data with a clear message if the file is absent.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Benchmarks",
  description:
    "Reproducible token-savings benchmarks for the ashlr-plugin — measured against the plugin's own source, updated weekly.",
  alternates: { canonical: "/benchmarks" },
  openGraph: {
    title: "Benchmarks",
    url: "/benchmarks",
    images: [{ url: "/og?title=Benchmarks&eyebrow=Reproducible", width: 1200, height: 630 }],
  },
  twitter: { card: "summary_large_image", images: ["/og?title=Benchmarks&eyebrow=Reproducible"] },
};

// ---------------------------------------------------------------------------
// Data types (mirrors scripts/run-benchmark.ts output schema)
// ---------------------------------------------------------------------------

interface ToolAggregate {
  mean: number;
  p50: number;
  p90: number;
}

interface ReadSample {
  path: string;
  bucket: string;
  rawBytes: number;
  rawTokens: number;
  ashlrBytes: number;
  ashlrTokens: number;
  ratio: number;
}

interface GrepSample {
  pattern: string;
  rawBytes: number;
  rawTokens: number;
  ashlrBytes: number;
  ashlrTokens: number;
  ratio: number;
  method: string;
}

interface EditSample {
  size: string;
  searchChars: number;
  replaceChars: number;
  naiveBytes: number;
  naiveTokens: number;
  ashlrBytes: number;
  ashlrTokens: number;
  ratio: number;
}

interface BenchmarkData {
  version: number;
  measuredAt: string;
  repo: { url: string; commit: string; files: number; loc: number };
  samples: {
    ashlr__read: ReadSample[];
    ashlr__grep: GrepSample[];
    ashlr__edit: EditSample[];
  };
  aggregate: {
    ashlr__read: ToolAggregate;
    ashlr__grep: ToolAggregate;
    ashlr__edit: ToolAggregate;
    overall: { mean: number };
  };
  methodology: string;
}

// ---------------------------------------------------------------------------
// Load data at build time
// ---------------------------------------------------------------------------

function loadBenchmarkData(): BenchmarkData | null {
  const candidates = [
    resolve(process.cwd(), "docs/benchmarks-v2.json"),
    resolve(process.cwd(), "../docs/benchmarks-v2.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf-8")) as BenchmarkData;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pctSaved(ratio: number): string {
  return `${((1 - ratio) * 100).toFixed(1)}%`;
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function shortCommit(sha: string): string {
  return sha.length >= 7 ? sha.slice(0, 7) : sha;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// SVG chart primitives
// ---------------------------------------------------------------------------

const CHART_W = 480;
const BAR_H = 32;
const BAR_GAP = 10;
const LABEL_W = 80;
const VALUE_W = 52;
const BAR_AREA = CHART_W - LABEL_W - VALUE_W;

/** Horizontal bar for mean/p50/p90 in a single row */
function BarRow({
  label,
  mean,
  p50,
  p90,
  color,
}: {
  label: string;
  mean: number;
  p50: number;
  p90: number;
  color: string;
}) {
  // Clamp ratios to [0, 1] for display (small edits can exceed 1)
  const cm = Math.min(1, Math.max(0, mean));
  const c50 = Math.min(1, Math.max(0, p50));
  const c90 = Math.min(1, Math.max(0, p90));

  // Savings = 1 - ratio; higher bar = more savings
  const sm = (1 - cm) * BAR_AREA;
  const s50 = (1 - c50) * BAR_AREA;
  const s90 = (1 - c90) * BAR_AREA;

  return (
    <g>
      {/* Label */}
      <text
        x={LABEL_W - 8}
        y={BAR_H / 2 + 5}
        textAnchor="end"
        fontSize={12}
        fill="var(--ink-55)"
        fontFamily="var(--font-jetbrains), monospace"
      >
        {label}
      </text>
      {/* Background track */}
      <rect x={LABEL_W} y={4} width={BAR_AREA} height={BAR_H - 8} rx={3} fill="var(--ink-10)" />
      {/* p90 bar (lightest) */}
      <rect x={LABEL_W} y={4} width={s90} height={BAR_H - 8} rx={3} fill={color} opacity={0.3} />
      {/* p50 bar */}
      <rect x={LABEL_W} y={6} width={s50} height={BAR_H - 12} rx={2} fill={color} opacity={0.6} />
      {/* mean bar (boldest) */}
      <rect x={LABEL_W} y={8} width={sm} height={BAR_H - 16} rx={2} fill={color} opacity={1} />
      {/* Value label */}
      <text
        x={LABEL_W + BAR_AREA + 8}
        y={BAR_H / 2 + 5}
        fontSize={12}
        fill="var(--ink-80)"
        fontFamily="var(--font-jetbrains), monospace"
        fontWeight={600}
      >
        -{pctSaved(mean)}
      </text>
    </g>
  );
}

function ToolBarChart({
  tool,
  agg,
  color,
}: {
  tool: string;
  agg: ToolAggregate;
  color: string;
}) {
  const rows = [
    { label: "mean", mean: agg.mean, p50: agg.mean, p90: agg.mean },
    { label: "p50", mean: agg.p50, p50: agg.p50, p90: agg.p50 },
    { label: "p90", mean: agg.p90, p50: agg.p90, p90: agg.p90 },
  ];
  const svgH = rows.length * (BAR_H + BAR_GAP) + BAR_GAP;

  return (
    <div style={{ marginBottom: 28 }}>
      <h3
        style={{
          fontFamily: "var(--font-jetbrains), monospace",
          fontSize: 13,
          color: "var(--ink-55)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        {tool}
      </h3>
      <svg
        width={CHART_W}
        height={svgH}
        viewBox={`0 0 ${CHART_W} ${svgH}`}
        style={{ maxWidth: "100%", display: "block" }}
        aria-label={`${tool} reduction bar chart: mean ${pctSaved(agg.mean)}, p50 ${pctSaved(agg.p50)}, p90 ${pctSaved(agg.p90)}`}
        role="img"
      >
        {rows.map((row, i) => (
          <g key={row.label} transform={`translate(0, ${i * (BAR_H + BAR_GAP) + BAR_GAP})`}>
            <BarRow {...row} color={color} />
          </g>
        ))}
      </svg>
      <div
        style={{
          fontSize: 11,
          color: "var(--ink-30)",
          marginTop: 4,
          fontFamily: "var(--font-jetbrains), monospace",
        }}
      >
        dark bar = mean &nbsp;·&nbsp; mid = p50 &nbsp;·&nbsp; light = p90
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scatter plot: read file size vs reduction ratio
// ---------------------------------------------------------------------------

function ScatterPlot({ samples }: { samples: ReadSample[] }) {
  if (samples.length === 0) return null;

  const W = 480;
  const H = 260;
  const PAD = { top: 20, right: 20, bottom: 40, left: 56 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const maxBytes = Math.max(...samples.map((s) => s.rawBytes), 1);
  // x: file size in bytes; y: savings (1 - ratio), 0..1
  const toX = (b: number) => (b / maxBytes) * plotW;
  const toY = (r: number) => plotH - Math.min(1, Math.max(0, 1 - r)) * plotH;

  const xTicks = [0.25, 0.5, 0.75, 1.0];
  const yTicks = [0, 0.25, 0.5, 0.75, 1.0];

  return (
    <div>
      <h3
        style={{
          fontFamily: "var(--font-jetbrains), monospace",
          fontSize: 13,
          color: "var(--ink-55)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        ashlr__read: file size vs. reduction
      </h3>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{ maxWidth: "100%", display: "block" }}
        aria-label="Scatter plot of file size versus token reduction ratio for ashlr__read"
        role="img"
      >
        <g transform={`translate(${PAD.left}, ${PAD.top})`}>
          {/* Grid lines */}
          {yTicks.map((t) => (
            <line
              key={t}
              x1={0}
              y1={toY(t)}
              x2={plotW}
              y2={toY(t)}
              stroke="var(--ink-10)"
              strokeWidth={1}
            />
          ))}
          {/* Y axis labels */}
          {yTicks.map((t) => (
            <text
              key={t}
              x={-8}
              y={toY(t) + 4}
              textAnchor="end"
              fontSize={10}
              fill="var(--ink-30)"
              fontFamily="var(--font-jetbrains), monospace"
            >
              {Math.round(t * 100)}%
            </text>
          ))}
          {/* X axis labels */}
          {xTicks.map((t) => (
            <text
              key={t}
              x={toX(t * maxBytes)}
              y={plotH + 16}
              textAnchor="middle"
              fontSize={10}
              fill="var(--ink-30)"
              fontFamily="var(--font-jetbrains), monospace"
            >
              {fmtBytes(t * maxBytes)}
            </text>
          ))}
          {/* Axis lines */}
          <line x1={0} y1={0} x2={0} y2={plotH} stroke="var(--ink-20)" strokeWidth={1} />
          <line x1={0} y1={plotH} x2={plotW} y2={plotH} stroke="var(--ink-20)" strokeWidth={1} />
          {/* Axis labels */}
          <text
            x={plotW / 2}
            y={plotH + 34}
            textAnchor="middle"
            fontSize={11}
            fill="var(--ink-40)"
            fontFamily="var(--font-jetbrains), monospace"
          >
            file size
          </text>
          <text
            x={-plotH / 2}
            y={-42}
            textAnchor="middle"
            fontSize={11}
            fill="var(--ink-40)"
            fontFamily="var(--font-jetbrains), monospace"
            transform="rotate(-90)"
          >
            tokens saved
          </text>
          {/* Data points */}
          {samples.map((s, i) => {
            const cx = toX(s.rawBytes);
            const cy = toY(s.ratio);
            const saved = pctSaved(s.ratio);
            return (
              <g key={i}>
                <circle cx={cx} cy={cy} r={5} fill="var(--debit)" opacity={0.8} />
                <text
                  x={cx + 7}
                  y={cy + 4}
                  fontSize={9}
                  fill="var(--ink-55)"
                  fontFamily="var(--font-jetbrains), monospace"
                >
                  -{saved}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BenchmarksPage() {
  const data = loadBenchmarkData();

  if (!data) {
    return (
      <main
        className="wrap"
        style={{ paddingTop: 80, paddingBottom: 80, maxWidth: 720 }}
      >
        <div className="eyebrow">Benchmarks</div>
        <h1 className="display-head" style={{ fontSize: "clamp(28px, 4vw, 48px)" }}>
          No benchmark data yet
        </h1>
        <p style={{ color: "var(--ink-55)", marginTop: 16, marginBottom: 32, lineHeight: 1.6 }}>
          Run the benchmark to generate data:
        </p>
        <pre
          className="ledger-card"
          style={{
            fontFamily: "var(--font-jetbrains), monospace",
            fontSize: 13,
            padding: "16px 20px",
            color: "var(--ink-80)",
          }}
        >
          bun run scripts/run-benchmark.ts --repo .
        </pre>
      </main>
    );
  }

  const overallPct = ((1 - data.aggregate.overall.mean) * 100).toFixed(1);
  const repoName =
    data.repo.url && data.repo.url !== "local"
      ? data.repo.url.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "")
      : "ashlr-plugin";

  return (
    <main style={{ paddingBottom: 80 }}>
      {/* ------------------------------------------------------------------ */}
      {/* Hero                                                                 */}
      {/* ------------------------------------------------------------------ */}
      <section
        className="wrap"
        style={{
          paddingTop: 72,
          paddingBottom: 64,
          borderBottom: "1px solid var(--ink-10)",
        }}
      >
        <div className="eyebrow">Benchmarks</div>
        <div
          style={{
            fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
            fontStyle: "italic",
            fontSize: "clamp(72px, 12vw, 140px)",
            fontWeight: 300,
            lineHeight: 0.9,
            color: "var(--debit)",
            letterSpacing: "-0.02em",
            fontVariationSettings: '"opsz" 72',
            marginTop: 24,
            marginBottom: 16,
          }}
          aria-label={`Mean minus ${overallPct} percent token savings`}
        >
          -{overallPct}%
        </div>
        <p
          style={{
            fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
            fontWeight: 300,
            fontSize: "clamp(16px, 2vw, 20px)",
            color: "var(--ink-55)",
            lineHeight: 1.5,
            maxWidth: 560,
          }}
        >
          Mean token savings across read, grep, and edit &mdash; measured against{" "}
          <code
            style={{
              fontFamily: "var(--font-jetbrains), monospace",
              fontSize: "0.85em",
              color: "var(--ink-80)",
            }}
          >
            {repoName}
          </code>
          , commit{" "}
          <code
            style={{
              fontFamily: "var(--font-jetbrains), monospace",
              fontSize: "0.85em",
              color: "var(--ink-80)",
            }}
          >
            {shortCommit(data.repo.commit)}
          </code>
          , on {fmtDate(data.measuredAt)}.
        </p>
        <div
          style={{
            display: "flex",
            gap: 32,
            flexWrap: "wrap",
            marginTop: 32,
          }}
        >
          {[
            ["files measured", data.repo.files.toLocaleString()],
            ["lines of code", data.repo.loc.toLocaleString()],
            ["read samples", data.samples.ashlr__read.length],
            ["grep patterns", data.samples.ashlr__grep.length],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <div
                style={{
                  fontFamily: "var(--font-jetbrains), monospace",
                  fontSize: 11,
                  color: "var(--ink-30)",
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  marginBottom: 4,
                }}
              >
                {label}
              </div>
              <div
                style={{
                  fontFamily: "var(--font-jetbrains), monospace",
                  fontSize: 22,
                  fontWeight: 600,
                  color: "var(--ink-80)",
                }}
              >
                {value}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Per-tool breakdown                                                   */}
      {/* ------------------------------------------------------------------ */}
      <section
        className="wrap"
        style={{ paddingTop: 56, paddingBottom: 56, borderBottom: "1px solid var(--ink-10)" }}
      >
        <h2
          style={{
            fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
            fontSize: "clamp(22px, 3vw, 32px)",
            fontWeight: 300,
            color: "var(--ink-80)",
            marginBottom: 36,
          }}
        >
          Per-tool breakdown
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: 40,
          }}
        >
          <ToolBarChart
            tool="ashlr__read"
            agg={data.aggregate.ashlr__read}
            color="var(--debit)"
          />
          <ToolBarChart
            tool="ashlr__grep"
            agg={data.aggregate.ashlr__grep}
            color="var(--debit)"
          />
          <ToolBarChart
            tool="ashlr__edit"
            agg={data.aggregate.ashlr__edit}
            color="var(--debit)"
          />
        </div>
        <p
          style={{
            fontSize: 12,
            color: "var(--ink-30)",
            marginTop: 12,
            fontFamily: "var(--font-jetbrains), monospace",
            lineHeight: 1.6,
          }}
        >
          ashlr__edit &ldquo;small&rdquo; scenario (15-char change) shows ratio &gt; 1 by design:
          the diff header is longer than the trivial before/after for tiny changes.
          Medium and large edits compress well. This is reported honestly.
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Scatter plot                                                          */}
      {/* ------------------------------------------------------------------ */}
      {data.samples.ashlr__read.length > 0 && (
        <section
          className="wrap"
          style={{
            paddingTop: 56,
            paddingBottom: 56,
            borderBottom: "1px solid var(--ink-10)",
          }}
        >
          <h2
            style={{
              fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
              fontSize: "clamp(22px, 3vw, 32px)",
              fontWeight: 300,
              color: "var(--ink-80)",
              marginBottom: 36,
            }}
          >
            Read sample scatter
          </h2>
          <ScatterPlot samples={data.samples.ashlr__read} />
          <p
            style={{
              fontSize: 12,
              color: "var(--ink-30)",
              marginTop: 16,
              fontFamily: "var(--font-jetbrains), monospace",
              lineHeight: 1.6,
              maxWidth: 520,
            }}
          >
            Each dot is one sampled file. x-axis = raw file size; y-axis = tokens saved.
            Files below 2 KB are excluded (snipCompact only fires above that threshold).
          </p>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Methodology                                                          */}
      {/* ------------------------------------------------------------------ */}
      <section
        className="wrap"
        style={{
          paddingTop: 56,
          paddingBottom: 56,
          borderBottom: "1px solid var(--ink-10)",
          maxWidth: 760,
        }}
      >
        <h2
          style={{
            fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
            fontSize: "clamp(22px, 3vw, 32px)",
            fontWeight: 300,
            color: "var(--ink-80)",
            marginBottom: 28,
          }}
        >
          Methodology
        </h2>
        <div
          style={{
            fontFamily: "var(--font-ibm-plex, IBM Plex Sans), sans-serif",
            fontSize: 15,
            lineHeight: 1.75,
            color: "var(--ink-70)",
            whiteSpace: "pre-wrap",
          }}
        >
          {data.methodology}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Reproducibility                                                       */}
      {/* ------------------------------------------------------------------ */}
      <section
        className="wrap"
        style={{ paddingTop: 56, paddingBottom: 56, borderBottom: "1px solid var(--ink-10)" }}
      >
        <h2
          style={{
            fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
            fontSize: "clamp(22px, 3vw, 32px)",
            fontWeight: 300,
            color: "var(--ink-80)",
            marginBottom: 24,
          }}
        >
          Reproduce it yourself
        </h2>
        <p
          style={{
            fontSize: 15,
            color: "var(--ink-55)",
            marginBottom: 16,
            lineHeight: 1.6,
          }}
        >
          Run the benchmark against any git repo you have locally:
        </p>
        <pre
          className="ledger-card"
          style={{
            fontFamily: "var(--font-jetbrains), monospace",
            fontSize: 13,
            padding: "16px 20px",
            color: "var(--ink-80)",
            overflowX: "auto",
          }}
        >
          {`# against the plugin itself (dogfood)
bun run scripts/run-benchmark.ts --repo .

# against any other repo
bun run scripts/run-benchmark.ts --repo /path/to/repo --out /tmp/results.json

# dry-run (no file written — useful for CI checks)
bun run scripts/run-benchmark.ts --dry-run`}
        </pre>
        <p
          style={{
            fontSize: 13,
            color: "var(--ink-30)",
            marginTop: 12,
            fontFamily: "var(--font-jetbrains), monospace",
          }}
        >
          Requires: bun, git, ripgrep (rg). Same commit SHA always picks the same files.
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Download raw data                                                    */}
      {/* ------------------------------------------------------------------ */}
      <section className="wrap" style={{ paddingTop: 48, paddingBottom: 48 }}>
        <h2
          style={{
            fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
            fontSize: "clamp(18px, 2.5vw, 26px)",
            fontWeight: 300,
            color: "var(--ink-80)",
            marginBottom: 16,
          }}
        >
          Raw data
        </h2>
        <p style={{ fontSize: 15, color: "var(--ink-55)", marginBottom: 16, lineHeight: 1.6 }}>
          The full JSON result file — every sample, every ratio, the exact methodology string.
        </p>
        <a
          href="/benchmarks-v2.json"
          className="btn btn-secondary"
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          Download benchmarks-v2.json
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M6 1v7M3 5l3 3 3-3M2 11h8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      </section>
    </main>
  );
}
