// Barrel export for all shared chart primitives.

export { default as LineChart } from "./line-chart";
export type { LineChartProps, LineSeries } from "./line-chart";

export { default as BarChart } from "./bar-chart";
export type { BarChartProps, BarGroup } from "./bar-chart";

export { default as AreaChart } from "./area-chart";
export type { AreaChartProps } from "./area-chart";

export { default as FunnelChart } from "./funnel-chart";
export type { FunnelChartProps, FunnelStep } from "./funnel-chart";

export { default as SparkChart } from "./spark-chart";
export type { SparkChartProps } from "./spark-chart";

export * from "./theme";

// Shared aria-label prop type — all chart components accept this optional prop.
export interface ChartAriaProps {
  ariaLabel?: string;
}
