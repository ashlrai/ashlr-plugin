"use client";

// Cross-machine sync table — pro-only.
// Free users see an upgrade prompt; pro users see per-machine stats.

import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  } catch {
    return isoDate;
  }
}

interface CrossMachineProps {
  machines: MachineStat[];
  isPro: boolean;
  className?: string;
}

export default function CrossMachine({ machines, isPro, className }: CrossMachineProps) {
  return (
    <Card className={cn("", className)}>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Cross-machine View</CardTitle>
          {isPro ? (
            <Badge variant="credit">Pro</Badge>
          ) : (
            <Badge>Free</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!isPro ? (
          <div
            className="flex flex-col gap-3 py-4"
            style={{ borderTop: "1px solid var(--ink-10)" }}
          >
            <p className="font-mono text-[12px] leading-relaxed" style={{ color: "var(--ink-55)" }}>
              See savings across all your machines in one view.
            </p>
            <Link
              href="/pricing"
              className="btn btn-primary"
              style={{ alignSelf: "flex-start" }}
            >
              Upgrade to Pro &rarr;
            </Link>
          </div>
        ) : machines.length === 0 ? (
          <p
            className="font-mono text-[12px] py-4"
            style={{ color: "var(--ink-30)", borderTop: "1px solid var(--ink-10)" }}
          >
            No other machines synced yet. Install ashlr on another machine and run{" "}
            <code className="font-mono text-[11px]">/ashlr-sync</code>.
          </p>
        ) : (
          <div
            role="table"
            aria-label="Cross-machine stats"
            style={{ borderTop: "1px solid var(--ink-10)" }}
          >
            {/* Header */}
            <div
              role="row"
              className="grid font-mono text-[10px] tracking-widest uppercase py-2 gap-3"
              style={{
                gridTemplateColumns: "1fr 80px 80px 100px",
                color: "var(--ink-30)",
                borderBottom: "1px solid var(--ink-10)",
              }}
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
                style={{
                  gridTemplateColumns: "1fr 80px 80px 100px",
                  borderBottom: "1px solid var(--ink-10)",
                  color: "var(--ink-80)",
                }}
              >
                <span
                  role="cell"
                  className="font-mono text-[11px] truncate"
                  style={{ color: "var(--ink-55)" }}
                  title={m.fingerprintHash}
                >
                  {m.fingerprintHash.slice(0, 12)}&hellip;
                </span>
                <span role="cell" style={{ color: "var(--ink-30)" }}>
                  {fmtRelative(m.lastSeen)}
                </span>
                <span role="cell" style={{ color: "var(--debit)" }}>
                  {fmtK(m.lifetimeTokensSaved)}
                </span>
                <span role="cell" style={{ color: "var(--ink-55)" }}>
                  {m.dominantTool}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
