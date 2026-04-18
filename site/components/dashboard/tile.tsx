"use client";

// Hero stat tile — parchment ledger-card with animated CountUp numbers.
// Respects prefers-reduced-motion by passing startWhen=false when motion is reduced.

import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import CountUp from "@/components/bits/CountUp";
import { cn } from "@/lib/utils";

interface TileProps {
  label: string;
  primaryValue: number;
  primarySuffix?: string;
  primaryDecimals?: number;
  secondaryLabel?: string;
  secondaryValue?: number;
  secondaryPrefix?: string;
  secondaryDecimals?: number;
  subline?: string;
  active?: boolean;
  className?: string;
}

export default function Tile({
  label,
  primaryValue,
  primarySuffix = "",
  primaryDecimals = 0,
  secondaryLabel,
  secondaryValue,
  secondaryPrefix = "",
  secondaryDecimals = 2,
  subline,
  active = false,
  className,
}: TileProps) {
  const [reducedMotion, setReducedMotion] = useState(false);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { threshold: 0.1 }
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, []);

  const shouldAnimate = visible && !reducedMotion;

  return (
    <Card ref={ref} className={cn("flex flex-col gap-0", className)}>
      <CardHeader className="pb-2">
        <CardTitle>{label}</CardTitle>
        {active && (
          <span
            className="mono-label"
            style={{ color: "var(--credit)", fontSize: 9, letterSpacing: "0.2em" }}
            aria-label="activity indicator — recent activity"
          >
            &#9650; active
          </span>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <div
          style={{
            fontFamily: "var(--font-fraunces), ui-serif",
            fontSize: "clamp(28px, 4vw, 40px)",
            fontWeight: 300,
            letterSpacing: "-0.02em",
            fontVariationSettings: '"SOFT" 20, "opsz" 40',
            color: "var(--debit)",
            lineHeight: 1.1,
          }}
          aria-label={`${label}: ${primaryValue.toLocaleString()}${primarySuffix}`}
        >
          <CountUp
            to={primaryValue}
            decimals={primaryDecimals}
            duration={1800}
            startWhen={shouldAnimate}
          />
          {primarySuffix && (
            <span style={{ fontSize: "0.5em", color: "var(--ink-55)", marginLeft: 4 }}>
              {primarySuffix}
            </span>
          )}
        </div>

        {secondaryValue !== undefined && (
          <div
            className="mono-label"
            style={{ color: "var(--ink-55)", fontSize: 11 }}
          >
            {secondaryLabel && <span>{secondaryLabel} </span>}
            <span style={{ color: "var(--debit)" }}>
              {secondaryPrefix}
              <CountUp
                to={secondaryValue}
                decimals={secondaryDecimals}
                duration={2000}
                startWhen={shouldAnimate}
              />
            </span>
          </div>
        )}

        {subline && (
          <p
            className="font-mono text-[11px] mt-1 leading-snug"
            style={{ color: "var(--ink-30)" }}
          >
            {subline}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
