"use client";

// Manual QA demo — NOT page-routed. Import into a dev-only page to visually
// verify all chart primitives render correctly with synthetic data.
//
// Usage in a throwaway page:
//   import ChartDemo from "@/components/charts/__demo__";
//   export default ChartDemo;

import LineChart from "./line-chart";
import BarChart from "./bar-chart";
import AreaChart from "./area-chart";
import FunnelChart from "./funnel-chart";
import SparkChart from "./spark-chart";

// --- Synthetic data ---

const days = Array.from({ length: 14 }, (_, i) => {
  const d = new Date("2026-04-25");
  d.setDate(d.getDate() + i);
  return d.toISOString().slice(0, 10);
});

const lineData = days.map((day, i) => ({
  day,
  p50: 80 + Math.round(Math.sin(i * 0.5) * 30 + i * 2),
  p95: 200 + Math.round(Math.cos(i * 0.4) * 60 + i * 3),
}));

const barData = [
  { tool_name: "ashlr__read", call_count: 420 },
  { tool_name: "ashlr__grep", call_count: 310 },
  { tool_name: "ashlr__edit", call_count: 280 },
  { tool_name: "ashlr__tree", call_count: 195 },
  { tool_name: "ashlr__bash", call_count: 140 },
];

const groupedBarData = days.slice(0, 7).map((date, i) => ({
  date,
  free: 20 + i * 3,
  pro: 5 + i * 2,
}));

const areaData = days.map((day, i) => ({
  day,
  median_ratio: 0.72 + Math.sin(i * 0.6) * 0.08,
}));

const funnelSteps = [
  { name: "Installed", value: 1200 },
  { name: "Activated", value: 870 },
  { name: "First save", value: 620 },
  { name: "Pro upgrade", value: 118 },
];

const sparkData = days.map((_, i) => ({
  v: 5000 + Math.round(Math.random() * 3000 + i * 200),
}));

// --- Demo component ---

export default function ChartDemo() {
  return (
    <div className="p-8 flex flex-col gap-10 max-w-4xl mx-auto">
      <h1 className="font-mono text-sm tracking-widest uppercase">Chart Primitives Demo</h1>

      <section>
        <p className="font-mono text-[11px] mb-3 opacity-50">LineChart — multi-series</p>
        <LineChart
          data={lineData}
          xKey="day"
          series={[
            { key: "p50", label: "p50 latency" },
            { key: "p95", label: "p95 latency" },
          ]}
          height={240}
        />
      </section>

      <section>
        <p className="font-mono text-[11px] mb-3 opacity-50">BarChart — single series</p>
        <BarChart
          data={barData}
          xKey="tool_name"
          yKey="call_count"
          label="Tool calls"
          height={240}
        />
      </section>

      <section>
        <p className="font-mono text-[11px] mb-3 opacity-50">BarChart — grouped</p>
        <BarChart
          data={groupedBarData}
          xKey="date"
          groups={[
            { key: "free", label: "Free" },
            { key: "pro", label: "Pro" },
          ]}
          height={240}
        />
      </section>

      <section>
        <p className="font-mono text-[11px] mb-3 opacity-50">AreaChart — gradient fill</p>
        <AreaChart
          data={areaData}
          xKey="day"
          yKey="median_ratio"
          label="Median savings ratio"
          height={240}
        />
      </section>

      <section>
        <p className="font-mono text-[11px] mb-3 opacity-50">FunnelChart — step progression</p>
        <FunnelChart steps={funnelSteps} height={280} />
      </section>

      <section>
        <p className="font-mono text-[11px] mb-3 opacity-50">SparkChart — minimal sparkline</p>
        <div className="w-48">
          <SparkChart data={sparkData} dataKey="v" height={40} />
        </div>
      </section>

      <section>
        <p className="font-mono text-[11px] mb-3 opacity-50">SparkChart — empty state</p>
        <div className="w-48">
          <SparkChart data={[]} dataKey="v" height={40} />
        </div>
      </section>

      <section>
        <p className="font-mono text-[11px] mb-3 opacity-50">LineChart — empty state</p>
        <LineChart data={[]} xKey="day" series={[{ key: "p50", label: "p50" }]} height={120} />
      </section>
    </div>
  );
}
