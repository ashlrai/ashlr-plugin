"use client";

// Projects annual token savings from the last 30-day rolling average.
// Big Fraunces number + dollar estimate in accountant's red.

import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import CountUp from "@/components/bits/CountUp";
import { cn } from "@/lib/utils";

// Rough cost estimate: $3 per 1M input tokens (Sonnet 4 midpoint).
const DOLLARS_PER_TOKEN = 3 / 1_000_000;

interface AnnualProjectionProps {
  last30DayTokens: number;
  className?: string;
}

export default function AnnualProjection({ last30DayTokens, className }: AnnualProjectionProps) {
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

  const annualTokens = Math.round((last30DayTokens / 30) * 365);
  const annualDollars = annualTokens * DOLLARS_PER_TOKEN;
  const shouldAnimate = visible && !reducedMotion;

  return (
    <Card ref={ref} className={cn("", className)}>
      <CardHeader className="pb-2">
        <CardTitle>Projected Annual Savings</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-baseline gap-4 mb-3">
          <div
            style={{
              fontFamily: "var(--font-fraunces), ui-serif",
              fontSize: "clamp(36px, 5vw, 56px)",
              fontWeight: 300,
              fontStyle: "italic",
              letterSpacing: "-0.03em",
              fontVariationSettings: '"SOFT" 20, "opsz" 40',
              color: "var(--ink)",
              lineHeight: 1,
            }}
            aria-label={`Projected annual tokens saved: ${annualTokens.toLocaleString()}`}
          >
            <CountUp to={annualTokens} decimals={0} duration={2200} startWhen={shouldAnimate} />
            <span
              className="font-mono"
              style={{
                fontSize: "0.3em",
                letterSpacing: "0.1em",
                color: "var(--ink-55)",
                marginLeft: 6,
                fontStyle: "normal",
              }}
            >
              tokens
            </span>
          </div>

          <div
            style={{
              fontFamily: "var(--font-fraunces), ui-serif",
              fontSize: "clamp(22px, 3vw, 32px)",
              fontWeight: 400,
              color: "var(--debit)",
              lineHeight: 1,
            }}
            aria-label={`Estimated annual dollar savings: $${annualDollars.toFixed(2)}`}
          >
            <span style={{ fontSize: "0.6em" }}>$</span>
            <CountUp
              to={annualDollars}
              decimals={2}
              duration={2400}
              startWhen={shouldAnimate}
            />
          </div>
        </div>

        <p
          className="font-mono text-[11px] leading-relaxed"
          style={{ color: "var(--ink-30)", maxWidth: 480 }}
        >
          Projection based on the last 30 days. Your actual may vary.
        </p>
      </CardContent>
    </Card>
  );
}
