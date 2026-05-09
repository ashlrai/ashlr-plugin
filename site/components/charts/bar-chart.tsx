"use client";

// Single or grouped bar chart wrapping Recharts BarChart.
// Single-series usage:
//   <BarChart data={rows} xKey="tool_name" yKey="call_count" label="Tool calls" />
//
// Grouped usage (multiple yKeys):
//   <BarChart data={rows} xKey="date" groups={[{ key: "free", label: "Free" }, { key: "pro", label: "Pro" }]} />

import {
  BarChart as ReBarChart,
  Bar,
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
  CHART_COLOR_PRIMARY,
  CHART_GRID_COLOR,
  CHART_AXIS_COLOR,
  CHART_AXIS_FONT_SIZE,
  CHART_AXIS_FONT_FAMILY,
  CHART_TOOLTIP_BG,
  CHART_TOOLTIP_BORDER,
  CHART_TOOLTIP_TEXT,
} from "./theme";

export interface BarGroup {
  key: string;
  label: string;
  color?: string;
}

export interface BarChartProps {
  data: Record<string, unknown>[];
  /** Key in each data row to use as the X axis label */
  xKey: string;
  /** Single-series: which key holds the value */
  yKey?: string;
  /** Single-series: axis/tooltip label */
  label?: string;
  /** Grouped: one entry per bar series */
  groups?: BarGroup[];
  /** Height in px (default 240) */
  height?: number;
  className?: string;
}

export default function BarChart({
  data,
  xKey,
  yKey,
  label = "Value",
  groups,
  height = 240,
  className,
}: BarChartProps) {
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

  const isGrouped = Array.isArray(groups) && groups.length > 0;

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ReBarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_COLOR} vertical={false} />
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
          {isGrouped && (
            <Legend
              wrapperStyle={{
                fontSize: CHART_AXIS_FONT_SIZE,
                fontFamily: CHART_AXIS_FONT_FAMILY,
              }}
            />
          )}
          {isGrouped
            ? groups!.map((g, i) => (
                <Bar
                  key={g.key}
                  dataKey={g.key}
                  name={g.label}
                  fill={g.color ?? CHART_PALETTE[i % CHART_PALETTE.length]}
                  radius={[3, 3, 0, 0]}
                />
              ))
            : (
                <Bar
                  dataKey={yKey ?? "value"}
                  name={label}
                  fill={CHART_COLOR_PRIMARY}
                  radius={[3, 3, 0, 0]}
                />
              )}
        </ReBarChart>
      </ResponsiveContainer>
    </div>
  );
}
