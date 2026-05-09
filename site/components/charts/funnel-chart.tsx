"use client";

// Funnel chart wrapping Recharts FunnelChart.
// Designed for wizard step progression (e.g., install → activate → first-save → pro).
// Usage:
//   <FunnelChart
//     steps={[
//       { name: "Installed", value: 1200 },
//       { name: "Activated", value: 900 },
//       { name: "First save", value: 600 },
//       { name: "Pro", value: 120 },
//     ]}
//   />

import {
  FunnelChart as ReFunnelChart,
  Funnel,
  LabelList,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";
import {
  CHART_PALETTE,
  CHART_AXIS_COLOR,
  CHART_AXIS_FONT_SIZE,
  CHART_AXIS_FONT_FAMILY,
  CHART_TOOLTIP_BG,
  CHART_TOOLTIP_BORDER,
  CHART_TOOLTIP_TEXT,
} from "./theme";

export interface FunnelStep {
  name: string;
  value: number;
  /** Override fill color */
  color?: string;
}

export interface FunnelChartProps {
  steps: FunnelStep[];
  /** Height in px (default 280) */
  height?: number;
  className?: string;
}

export default function FunnelChart({
  steps,
  height = 280,
  className,
}: FunnelChartProps) {
  if (!steps.length) {
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

  // Recharts Funnel expects `fill` on each data item
  const data = steps.map((s, i) => ({
    ...s,
    fill: s.color ?? CHART_PALETTE[i % CHART_PALETTE.length],
  }));

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ReFunnelChart>
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
          <Funnel dataKey="value" data={data} isAnimationActive>
            <LabelList
              position="right"
              fill={CHART_AXIS_COLOR}
              stroke="none"
              dataKey="name"
              style={{ fontSize: CHART_AXIS_FONT_SIZE, fontFamily: CHART_AXIS_FONT_FAMILY }}
            />
          </Funnel>
        </ReFunnelChart>
      </ResponsiveContainer>
    </div>
  );
}
