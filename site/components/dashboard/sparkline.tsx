"use client";

// Two-row sparkline: 7-day and 30-day token savings.
// Busiest day highlighted in debit red. Pure SVG, responsive.

import { type DayStat } from "@/lib/api";
import { cn } from "@/lib/utils";

interface SparkRowProps {
  label: string;
  data: DayStat[];
  color?: string;
}

const ROW_H = 40;
const TICK_W = 6;
const TICK_GAP = 3;

function SparkRow({ label, data, color = "var(--ink-30)" }: SparkRowProps) {
  if (!data.length) return null;

  const maxVal = Math.max(...data.map((d) => d.tokensSaved), 1);
  const maxIdx = data.reduce((best, d, i) => (d.tokensSaved > data[best].tokensSaved ? i : best), 0);

  const totalW = data.length * (TICK_W + TICK_GAP) - TICK_GAP;

  return (
    <div className="flex items-center gap-4">
      <span
        className="mono-label shrink-0"
        style={{ width: 44, textAlign: "right" }}
      >
        {label}
      </span>
      <svg
        viewBox={`0 0 ${totalW} ${ROW_H}`}
        width={totalW}
        height={ROW_H}
        style={{ width: "100%", maxWidth: totalW * 2, height: ROW_H, display: "block" }}
        role="img"
        aria-label={`${label} sparkline — busiest day: ${data[maxIdx]?.date ?? ""} with ${data[maxIdx]?.tokensSaved.toLocaleString() ?? 0} tokens saved`}
      >
        {data.map((d, i) => {
          const barH = Math.max(2, (d.tokensSaved / maxVal) * (ROW_H - 4));
          const x = i * (TICK_W + TICK_GAP);
          const y = ROW_H - barH;
          const isBusiest = i === maxIdx;

          return (
            <rect
              key={d.date}
              x={x}
              y={y}
              width={TICK_W}
              height={barH}
              rx={1}
              fill={isBusiest ? "var(--debit)" : color}
              aria-label={`${d.date}: ${d.tokensSaved.toLocaleString()} tokens`}
            >
              <title>{`${d.date}: ${d.tokensSaved.toLocaleString()} tokens`}</title>
            </rect>
          );
        })}
      </svg>
      <span
        className="mono-label shrink-0"
        style={{ color: "var(--debit)", fontSize: 10 }}
        aria-hidden="true"
      >
        {data[maxIdx]?.date?.slice(5) ?? ""}
      </span>
    </div>
  );
}

interface SparklineProps {
  last7Days: DayStat[];
  last30Days: DayStat[];
  className?: string;
}

export default function Sparkline({ last7Days, last30Days, className }: SparklineProps) {
  return (
    <div className={cn("flex flex-col gap-5", className)}>
      <SparkRow label="7d" data={last7Days} />
      <SparkRow label="30d" data={last30Days} color="rgba(18,18,18,0.2)" />
    </div>
  );
}
