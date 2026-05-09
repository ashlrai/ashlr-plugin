"use client";

// Per-tool token savings bar chart.
// Internals upgraded from hand-rolled SVG to shared <BarChart> primitive (Stage 2).
// Prop shape preserved for callers: ToolChartProps { tools: ToolStat[] }.

import { type ToolStat } from "@/lib/api";
import { BarChart } from "@/components/charts";
import { cn } from "@/lib/utils";

interface ToolChartProps {
  tools: ToolStat[];
  className?: string;
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function ToolChart({ tools, className }: ToolChartProps) {
  const sorted = [...tools]
    .sort((a, b) => b.tokensSaved - a.tokensSaved)
    .map((t) => ({
      tool: t.tool.length > 18 ? t.tool.slice(0, 17) + "…" : t.tool,
      tokens_saved: t.tokensSaved,
      calls: t.calls,
    }));

  return (
    <div className={cn("w-full", className)}>
      <BarChart
        data={sorted}
        xKey="tool"
        yKey="tokens_saved"
        label="Tokens saved"
        height={Math.max(180, sorted.length * 36)}
      />
      <div
        className="flex gap-6 mt-2 font-mono text-[10px] tracking-widest uppercase"
        style={{ color: "var(--ink-30)" }}
      >
        <span>tokens saved</span>
        <span className="ml-auto">
          top: {sorted[0]?.tool ?? "—"} ({fmtK(sorted[0]?.tokens_saved ?? 0)})
        </span>
      </div>
    </div>
  );
}
