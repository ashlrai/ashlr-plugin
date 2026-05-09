"use client";

// Single-series area chart with gradient fill, wrapping Recharts AreaChart.
// Usage:
//   <AreaChart data={rows} xKey="day" yKey="median_ratio" label="Median ratio" />

import {
  AreaChart as ReAreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";
import {
  CHART_COLOR_PRIMARY,
  CHART_GRID_COLOR,
  CHART_AXIS_COLOR,
  CHART_AXIS_FONT_SIZE,
  CHART_AXIS_FONT_FAMILY,
  CHART_TOOLTIP_BG,
  CHART_TOOLTIP_BORDER,
  CHART_TOOLTIP_TEXT,
  GRADIENT_ID_AREA,
} from "./theme";

export interface AreaChartProps {
  data: Record<string, unknown>[];
  /** Key in each data row for X axis */
  xKey: string;
  /** Key in each data row for Y axis */
  yKey: string;
  /** Tooltip / legend label */
  label?: string;
  /** Gradient top color (default: CHART_COLOR_PRIMARY) */
  color?: string;
  /** Height in px (default 240) */
  height?: number;
  className?: string;
}

export default function AreaChart({
  data,
  xKey,
  yKey,
  label = "Value",
  color = CHART_COLOR_PRIMARY,
  height = 240,
  className,
}: AreaChartProps) {
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

  // Unique gradient ID per color to avoid collisions when multiple instances render
  const gradientId = `${GRADIENT_ID_AREA}-${color.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ReAreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.25} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
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
          <Area
            type="monotone"
            dataKey={yKey}
            name={label}
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 4 }}
          />
        </ReAreaChart>
      </ResponsiveContainer>
    </div>
  );
}
