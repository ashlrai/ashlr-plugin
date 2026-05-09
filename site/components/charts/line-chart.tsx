"use client";

// Multi-series line chart wrapping Recharts LineChart.
// Usage:
//   <LineChart
//     data={[{ day: "2026-05-01", p50: 120, p95: 340 }, ...]}
//     xKey="day"
//     series={[{ key: "p50", label: "p50" }, { key: "p95", label: "p95" }]}
//   />

import {
  LineChart as ReLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";
import {
  CHART_PALETTE,
  CHART_GRID_COLOR,
  CHART_AXIS_COLOR,
  CHART_AXIS_FONT_SIZE,
  CHART_AXIS_FONT_FAMILY,
  CHART_TOOLTIP_BG,
  CHART_TOOLTIP_BORDER,
  CHART_TOOLTIP_TEXT,
} from "./theme";

export interface LineSeries {
  key: string;
  label: string;
  /** Override color; defaults to CHART_PALETTE[index] */
  color?: string;
}

export interface LineChartProps {
  data: Record<string, unknown>[];
  /** Key in each data row to use as the X axis label */
  xKey: string;
  /** One entry per line to render */
  series: LineSeries[];
  /** Height in px (default 240) */
  height?: number;
  /** Accessible label for the chart region (role="img") */
  ariaLabel?: string;
  className?: string;
}

export default function LineChart({
  data,
  xKey,
  series,
  height = 240,
  ariaLabel,
  className,
}: LineChartProps) {
  if (!data.length) {
    return (
      <div
        className={cn(
          "flex items-center justify-center font-mono text-[11px] tracking-widest uppercase",
          className,
        )}
        style={{ height, color: CHART_AXIS_COLOR }}
      >
        No data yet
      </div>
    );
  }

  return (
    <div
      className={cn("w-full", className)}
      style={{ height }}
      role="img"
      aria-label={ariaLabel ?? `Line chart`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ReLineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} />
          <XAxis
            dataKey={xKey}
            tick={{ fontSize: CHART_AXIS_FONT_SIZE, fontFamily: CHART_AXIS_FONT_FAMILY, fill: CHART_AXIS_COLOR }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: CHART_AXIS_FONT_SIZE, fontFamily: CHART_AXIS_FONT_FAMILY, fill: CHART_AXIS_COLOR }}
            axisLine={false}
            tickLine={false}
            width={40}
          />
          <Tooltip
            contentStyle={{
              background: CHART_TOOLTIP_BG,
              border: `1px solid ${CHART_TOOLTIP_BORDER}`,
              borderRadius: 6,
              fontSize: CHART_AXIS_FONT_SIZE,
              fontFamily: CHART_AXIS_FONT_FAMILY,
              color: CHART_TOOLTIP_TEXT,
            }}
          />
          {series.length > 1 && (
            <Legend
              wrapperStyle={{
                fontSize: CHART_AXIS_FONT_SIZE,
                fontFamily: CHART_AXIS_FONT_FAMILY,
              }}
            />
          )}
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.color ?? CHART_PALETTE[i % CHART_PALETTE.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
        </ReLineChart>
      </ResponsiveContainer>
    </div>
  );
}
