"use client";

// Cross-machine view — pro-only.
// Free: upgrade prompt. Pro: static machine table + per-machine timeline LineChart.
// Prop shape preserved: CrossMachineProps { machines, isPro }.

import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LineChart } from "@/components/charts";
import { type MachineStat } from "@/lib/api";
import { cn } from "@/lib/utils";

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtRelative(isoDate: string): string {
  try {
    const diff = Date.now() - new Date(isoDate).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 2) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch {
    return isoDate;
  }
}

interface CrossMachineTimelinePoint {
  day: string;
  machine: string;
  tokens_saved: number;
}

interface CrossMachineProps {
  machines: MachineStat[];
  isPro: boolean;
  /** Optional timeline data for the Pro LineChart (fetched by parent) */
  timeline?: CrossMachineTimelinePoint[];
  className?: string;
}

/** Pivot flat timeline rows into { day, [machineId]: tokens } for LineChart */
function pivotTimeline(
  rows: CrossMachineTimelinePoint[],
): { data: Record<string, unknown>[]; machines: string[] } {
  const machineSet = new Set<string>();
  const byDay: Record<string, Record<string, number>> = {};

  for (const row of rows) {
    machineSet.add(row.machine);
    if (!byDay[row.day]) byDay[row.day] = {};
    byDay[row.day]![row.machine] = row.tokens_saved;
  }

  const machines = [...machineSet];
  const data = Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, vals]) => ({ day, ...vals }));

  return { data, machines };
}

export default function CrossMachine({ machines, isPro, timeline, className }: CrossMachineProps) {
  const { data: timelineData, machines: machineIds } = timeline?.length
    ? pivotTimeline(timeline)
    : { data: [], machines: [] };

  return (
    <Card className={cn("", className)}>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Cross-machine View</CardTitle>
          {isPro ? <Badge variant="credit">Pro</Badge> : <Badge>Free</Badge>}
        </div>
      </CardHeader>
      <CardContent>
        {!isPro ? (
          <div className="flex flex-col gap-3 py-4" style={{ borderTop: "1px solid var(--ink-10)" }}>
            <p className="font-mono text-[12px] leading-relaxed" style={{ color: "var(--ink-55)" }}>
              See savings across all your machines in one view.
            </p>
            <Link href="/pricing" className="btn btn-primary" style={{ alignSelf: "flex-start" }}>
              Upgrade to Pro &rarr;
            </Link>
          </div>
        ) : machines.length === 0 ? (
          <p className="font-mono text-[12px] py-4" style={{ color: "var(--ink-30)", borderTop: "1px solid var(--ink-10)" }}>
            No other machines synced yet. Install ashlr on another machine and run{" "}
            <code className="font-mono text-[11px]">/ashlr-sync</code>.
          </p>
        ) : (
          <div>
            {/* Static machine table */}
            <div role="table" aria-label="Cross-machine stats" style={{ borderTop: "1px solid var(--ink-10)" }}>
              <div
                role="row"
                className="grid font-mono text-[10px] tracking-widest uppercase py-2 gap-3"
                style={{ gridTemplateColumns: "1fr 80px 80px 100px", color: "var(--ink-30)", borderBottom: "1px solid var(--ink-10)" }}
              >
                <span role="columnheader">Machine</span>
                <span role="columnheader">Last seen</span>
                <span role="columnheader">Tokens</span>
                <span role="columnheader">Top tool</span>
              </div>
              {machines.map((m) => (
                <div
                  key={m.fingerprintHash}
                  role="row"
                  className="grid font-mono text-[11px] py-3 gap-3 items-center"
                  style={{ gridTemplateColumns: "1fr 80px 80px 100px", borderBottom: "1px solid var(--ink-10)", color: "var(--ink-80)" }}
                >
                  <span role="cell" className="font-mono text-[11px] truncate" style={{ color: "var(--ink-55)" }} title={m.fingerprintHash}>
                    {m.fingerprintHash.slice(0, 12)}&hellip;
                  </span>
                  <span role="cell" style={{ color: "var(--ink-30)" }}>{fmtRelative(m.lastSeen)}</span>
                  <span role="cell" style={{ color: "var(--debit)" }}>{fmtK(m.lifetimeTokensSaved)}</span>
                  <span role="cell" style={{ color: "var(--ink-55)" }}>{m.dominantTool}</span>
                </div>
              ))}
            </div>

            {/* Per-machine daily timeline (Pro LineChart) */}
            {timelineData.length > 0 && (
              <div className="mt-6">
                <p className="font-mono text-[10px] tracking-widest uppercase mb-3" style={{ color: "var(--ink-30)" }}>
                  Daily savings by machine
                </p>
                <LineChart
                  data={timelineData}
                  xKey="day"
                  series={machineIds.map((id) => ({
                    key: id,
                    label: id.length > 12 ? id.slice(0, 11) + "…" : id,
                  }))}
                  height={200}
                  ariaLabel="Daily token savings by machine over time"
                />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
