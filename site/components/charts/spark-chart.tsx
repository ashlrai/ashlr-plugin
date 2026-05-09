"use client";

// Minimal sparkline — no axes, no grid, no tooltip labels.
// Replaces the inline SVG approach in components/dashboard/sparkline.tsx
// with a Recharts-backed version for consistency.
// Usage:
//   <SparkChart data={[{ v: 10 }, { v: 40 }, { v: 25 }]} dataKey="v" />
//   <SparkChart data={dayStats} dataKey="tokensSaved" color="#c94f4f" />

import {
  AreaChart,
  Area,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { cn } from "@/lib/utils";
import {
  CHART_COLOR_PRIMARY,
  CHART_TOOLTIP_BG,
  CHART_TOOLTIP_BORDER,
  CHART_TOOLTIP_TEXT,
  CHART_AXIS_FONT_SIZE,
  CHART_AXIS_FONT_FAMILY,
} from "./theme";

export interface SparkChartProps {
  data: Record<string, unknown>[];
  /** Key holding the numeric value in each row */
  dataKey: string;
  /** Stroke + fill color (default: CHART_COLOR_PRIMARY) */
  color?: string;
  /** Height in px (default 40) */
  height?: number;
  /** Show a hover tooltip (default: false) */
  showTooltip?: boolean;
  className?: string;
}

export default function SparkChart({
  data,
  dataKey,
  color = CHART_COLOR_PRIMARY,
  height = 40,
  showTooltip = false,
  className,
}: SparkChartProps) {
  if (!data.length) {
    return (
      <div
        className={cn("w-full rounded", className)}
        style={{ height, background: "rgba(18,18,18,0.04)" }}
      />
    );
  }

  const gradientId = `spark-fill-${dataKey}-${color.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          {showTooltip && (
            <Tooltip
              contentStyle={{
                background: CHART_TOOLTIP_BG,
                border: `1px solid ${CHART_TOOLTIP_BORDER}`,
                borderRadius: 4,
                fontSize: CHART_AXIS_FONT_SIZE,
                fontFamily: CHART_AXIS_FONT_FAMILY,
                color: CHART_TOOLTIP_TEXT,
              }}
            />
          )}
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
