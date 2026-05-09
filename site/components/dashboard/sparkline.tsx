"use client";

// Two-row sparkline: 7-day and 30-day token savings.
// Internals upgraded from hand-rolled SVG to shared <SparkChart> (Stage 2).
// Prop shape preserved: SparklineProps { last7Days, last30Days }.

import { type DayStat } from "@/lib/api";
import { SparkChart } from "@/components/charts";
import { cn } from "@/lib/utils";

interface SparklineProps {
  last7Days: DayStat[];
  last30Days: DayStat[];
  className?: string;
}

interface SparkRowProps {
  label: string;
  data: DayStat[];
  color?: string;
}

function SparkRow({ label, data, color }: SparkRowProps) {
  if (!data.length) return null;

  const maxIdx = data.reduce(
    (best, d, i) => (d.tokensSaved > data[best]!.tokensSaved ? i : best),
    0,
  );
  const peakDate = data[maxIdx]?.date?.slice(5) ?? "";

  return (
    <div className="flex items-center gap-4">
      <span
        className="font-mono text-[10px] tracking-widest uppercase shrink-0"
        style={{ width: 44, textAlign: "right", color: "var(--ink-30)" }}
      >
        {label}
      </span>
      <div className="flex-1">
        <SparkChart
          data={data.map((d) => ({ date: d.date, tokensSaved: d.tokensSaved }))}
          dataKey="tokensSaved"
          color={color ?? "var(--ink-30)"}
          height={40}
          showTooltip
        />
      </div>
      <span
        className="font-mono text-[10px] shrink-0"
        style={{ color: "var(--debit)", minWidth: 36, textAlign: "right" }}
        aria-hidden="true"
      >
        {peakDate}
      </span>
    </div>
  );
}

export default function Sparkline({ last7Days, last30Days, className }: SparklineProps) {
  return (
    <div className={cn("flex flex-col gap-5", className)}>
      <SparkRow label="7d" data={last7Days} color="var(--debit)" />
      <SparkRow label="30d" data={last30Days} color="rgba(18,18,18,0.25)" />
    </div>
  );
}
