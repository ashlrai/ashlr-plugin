"use client";

// KPI hero number tile — big value, label, optional delta indicator.
// Matches the parchment ledger-card aesthetic used across the dashboard.
// Usage:
//   <KpiTile label="MRR" value="$1,240" delta="+12%" deltaPositive={true} />
//   <KpiTile label="Total users" value="3,842" />

import { cn } from "@/lib/utils";

export interface KpiTileProps {
  /** Short label shown above the value */
  label: string;
  /** Pre-formatted value string (e.g. "$1,240" or "3,842") */
  value: string;
  /** Optional delta string (e.g. "+12%" or "-3%") */
  delta?: string;
  /** True = green/credit, false = red/debit, undefined = neutral */
  deltaPositive?: boolean;
  /** Optional subline beneath the value */
  subline?: string;
  className?: string;
}

export default function KpiTile({
  label,
  value,
  delta,
  deltaPositive,
  subline,
  className,
}: KpiTileProps) {
  const deltaColor =
    deltaPositive === true
      ? "var(--credit, #2a7a4b)"
      : deltaPositive === false
      ? "var(--debit, #c94f4f)"
      : "var(--ink-55, rgba(18,18,18,0.55))";

  return (
    <div className={cn("ledger-card flex flex-col gap-1 p-5", className)}>
      {/* Label */}
      <span
        className="font-mono text-[11px] tracking-[0.18em] uppercase"
        style={{ color: "var(--ink-55, rgba(18,18,18,0.55))" }}
      >
        {label}
      </span>

      {/* Value row */}
      <div className="flex items-baseline gap-3">
        <span
          style={{
            fontFamily: "var(--font-fraunces, ui-serif)",
            fontSize: "clamp(24px, 3.5vw, 36px)",
            fontWeight: 300,
            letterSpacing: "-0.02em",
            color: "var(--debit, #c94f4f)",
            lineHeight: 1.1,
          }}
          aria-label={`${label}: ${value}`}
        >
          {value}
        </span>

        {delta && (
          <span
            className="font-mono text-[11px] tracking-[0.12em]"
            style={{ color: deltaColor }}
            aria-label={`Change: ${delta}`}
          >
            {delta}
          </span>
        )}
      </div>

      {/* Optional subline */}
      {subline && (
        <p
          className="font-mono text-[11px] leading-snug mt-0.5"
          style={{ color: "var(--ink-30, rgba(18,18,18,0.3))" }}
        >
          {subline}
        </p>
      )}
    </div>
  );
}
