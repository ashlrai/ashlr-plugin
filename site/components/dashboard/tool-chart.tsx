"use client";

// Horizontal SVG bar chart — one row per tool, sorted desc by lifetime tokens saved.
// Hover shows delta from last week. Respects prefers-reduced-motion.

import { useState, useEffect } from "react";
import { type ToolStat } from "@/lib/api";
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

const BAR_HEIGHT = 20;
const ROW_GAP = 14;
const LABEL_W = 120;
const META_W = 110;
const PADDING = 24;

export default function ToolChart({ tools, className }: ToolChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
  }, []);

  const sorted = [...tools].sort((a, b) => b.tokensSaved - a.tokensSaved);
  const total = sorted.reduce((s, t) => s + t.tokensSaved, 0);
  const max = sorted[0]?.tokensSaved ?? 1;

  const rowH = BAR_HEIGHT + ROW_GAP;
  const svgH = PADDING + sorted.length * rowH + PADDING;

  // Available bar width computed as proportion of a reference 640px width.
  // The SVG uses a viewBox and scales responsively.
  const viewW = 640;
  const barAreaW = viewW - LABEL_W - META_W - PADDING * 2;

  return (
    <div className={cn("w-full", className)}>
      <svg
        viewBox={`0 0 ${viewW} ${svgH}`}
        width={viewW}
        height={svgH}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
        aria-label={`Per-tool token savings bar chart. Top tool: ${sorted[0]?.tool ?? "none"} with ${fmtK(sorted[0]?.tokensSaved ?? 0)} tokens saved.`}
      >
        {sorted.map((tool, i) => {
          const y = PADDING + i * rowH;
          const barW = total === 0 ? 0 : (tool.tokensSaved / max) * barAreaW;
          const pct = total === 0 ? 0 : (tool.tokensSaved / total) * 100;
          const isHovered = hoveredIndex === i;
          const deltaSign = tool.tokensSaved - tool.lastWeekTokensSaved >= 0 ? "+" : "";
          const delta = tool.tokensSaved - tool.lastWeekTokensSaved;

          return (
            <g
              key={tool.tool}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(null)}
              onFocus={() => setHoveredIndex(i)}
              onBlur={() => setHoveredIndex(null)}
              tabIndex={0}
              role="row"
              aria-label={`${tool.tool}: ${tool.calls} calls, ${fmtK(tool.tokensSaved)} tokens saved (${pct.toFixed(1)}% of total)`}
              style={{ cursor: "default", outline: "none" }}
            >
              {/* Tool label */}
              <text
                x={PADDING}
                y={y + BAR_HEIGHT / 2 + 4}
                fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
                fontSize={11}
                fill={isHovered ? "var(--ink)" : "rgba(18,18,18,0.55)"}
                style={{ transition: reducedMotion ? "none" : "fill 0.15s" }}
              >
                {tool.tool.length > 14 ? tool.tool.slice(0, 13) + "\u2026" : tool.tool}
              </text>

              {/* Bar background */}
              <rect
                x={PADDING + LABEL_W}
                y={y}
                width={barAreaW}
                height={BAR_HEIGHT}
                rx={2}
                fill="rgba(18,18,18,0.06)"
              />

              {/* Bar fill */}
              <rect
                x={PADDING + LABEL_W}
                y={y}
                width={barW}
                height={BAR_HEIGHT}
                rx={2}
                fill={isHovered ? "var(--debit)" : "var(--ink-30)"}
                style={{
                  transition: reducedMotion ? "none" : "width 0.6s cubic-bezier(0.4,0,0.2,1), fill 0.15s",
                }}
              />

              {/* Calls count */}
              <text
                x={PADDING + LABEL_W + barAreaW + 8}
                y={y + BAR_HEIGHT / 2 + 4}
                fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
                fontSize={10}
                fill="rgba(18,18,18,0.4)"
                textAnchor="start"
              >
                {fmtK(tool.tokensSaved)}
              </text>

              {/* Percentage */}
              <text
                x={viewW - PADDING}
                y={y + BAR_HEIGHT / 2 + 4}
                fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
                fontSize={10}
                fill="var(--credit)"
                textAnchor="end"
              >
                {pct.toFixed(1)}%
              </text>

              {/* Hover tooltip: delta from last week */}
              {isHovered && (
                <text
                  x={PADDING + LABEL_W + barW + 6}
                  y={y - 4}
                  fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
                  fontSize={9}
                  fill={delta >= 0 ? "var(--credit)" : "var(--debit)"}
                >
                  {deltaSign}{fmtK(delta)} vs last wk
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Legend row */}
      <div
        className="flex gap-6 mt-2"
        style={{ paddingLeft: PADDING + LABEL_W }}
      >
        <span className="mono-label">tokens saved</span>
        <span className="mono-label" style={{ marginLeft: "auto", paddingRight: META_W / 2 }}>% of total</span>
      </div>
    </div>
  );
}
