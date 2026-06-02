"use client";

// Animated "what ashlr actually saves" proof block for the Community Ledger.
// All numbers are REAL benchmark data from @/lib/tools (reproducible via
// `bun run bench`) — this is what the community total is accumulating.

import { useEffect, useRef, useState } from "react";
import CountUp from "./bits/CountUp";
import { benchmarkSummary, benchmarkRows } from "@/lib/tools";

function Row({
  label,
  tokens,
  max,
  color,
  strong,
  inView,
  delay,
}: {
  label: string;
  tokens: number;
  max: number;
  color: string;
  strong?: boolean;
  inView: boolean;
  delay: number;
}) {
  const pct = Math.max(2, (tokens / max) * 100);
  return (
    <div className="flex items-center gap-3 min-w-0">
      <span
        className="font-mono text-[11px] shrink-0 tabular-nums"
        style={{ width: "clamp(80px, 9vw, 110px)", color: "var(--ink-55)", textAlign: "right" }}
      >
        {tokens.toLocaleString()}
      </span>
      <div className="flex-1 relative h-6" style={{ background: "var(--ink-10)" }}>
        <div
          style={{
            position: "absolute",
            inset: "0 auto 0 0",
            width: inView ? `${pct}%` : "0%",
            background: color,
            transition: inView ? `width 1s cubic-bezier(0.22, 1, 0.36, 1) ${delay}ms` : "none",
          }}
        />
      </div>
      <span
        className="font-mono text-[11px] shrink-0"
        style={{ color: strong ? "var(--debit)" : "var(--ink-55)", minWidth: 92, fontWeight: strong ? 600 : 400 }}
      >
        {label}
      </span>
    </div>
  );
}

export default function CommunityProof() {
  const [inView, setInView] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) setInView(true);
      },
      { threshold: 0.15 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const { withoutAshlr, withAshlr, savingsPct, label } = benchmarkSummary;

  return (
    <div ref={ref}>
      {/* Headline stat */}
      <div className="ledger-card inline-flex items-baseline gap-4 px-7 py-5 mb-10">
        <span
          className="font-mono tabular-nums"
          style={{ fontSize: "clamp(40px, 6vw, 64px)", color: "var(--debit)", fontWeight: 600, lineHeight: 1 }}
        >
          &minus;<CountUp to={savingsPct} from={0} duration={1700} decimals={1} startWhen={inView} />%
        </span>
        <span
          className="font-mono text-[12px] tracking-[0.1em] uppercase"
          style={{ color: "var(--ink-55)", maxWidth: 180 }}
        >
          {label}
        </span>
      </div>

      {/* Before / after, one large read */}
      <div className="ledger-card overflow-hidden mb-10" style={{ maxWidth: 760 }}>
        <div className="px-5 py-3 border-b border-[var(--ink-10)]" style={{ background: "var(--paper)" }}>
          <span className="mono-label">Tokens sent to the model &middot; one large file read</span>
        </div>
        <div className="p-5 space-y-4" style={{ background: "var(--paper-deep)" }}>
          <Row label="native read" tokens={withoutAshlr} max={withoutAshlr} color="var(--ink-30)" inView={inView} delay={0} />
          <Row label="with ashlr" tokens={withAshlr} max={withoutAshlr} color="var(--debit)" strong inView={inView} delay={220} />
        </div>
      </div>

      {/* File-by-file */}
      <div className="ledger-card overflow-hidden" style={{ maxWidth: 760 }}>
        <div
          className="flex items-center justify-between px-5 py-3 border-b border-[var(--ink-10)]"
          style={{ background: "var(--paper)" }}
        >
          <span className="mono-label">File-by-file &middot; ashlr-plugin source</span>
          <span className="mono-label">saved</span>
        </div>
        {benchmarkRows.map((row, i) => (
          <div
            key={row.path}
            className="flex items-center gap-4 px-5 py-3"
            style={{
              borderBottom: i < benchmarkRows.length - 1 ? "1px dashed var(--ink-10)" : "none",
              background: "var(--paper-deep)",
            }}
          >
            <span
              className="font-mono text-[12px] flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
              style={{ color: "var(--ink-80)" }}
            >
              {row.path}
            </span>
            <div className="shrink-0 relative h-2" style={{ width: 120, background: "var(--ink-10)" }}>
              <div
                style={{
                  position: "absolute",
                  inset: "0 auto 0 0",
                  width: inView ? `${row.savedPct}%` : "0%",
                  background: "var(--debit)",
                  transition: inView ? `width 0.85s cubic-bezier(0.22, 1, 0.36, 1) ${i * 110 + 320}ms` : "none",
                }}
              />
            </div>
            <span
              className="font-mono text-[12px] tabular-nums shrink-0"
              style={{ color: "var(--debit)", minWidth: 52, textAlign: "right" }}
            >
              &minus;{row.savedPct}%
            </span>
          </div>
        ))}
      </div>

      <p className="font-mono text-[11px] mt-5" style={{ color: "var(--ink-30)" }}>
        Reproduce on your own repo: <code style={{ color: "var(--ink-55)" }}>bun run bench</code> &middot;{" "}
        <a href="/benchmarks" style={{ color: "var(--debit)", textDecoration: "underline", textUnderlineOffset: 3 }}>
          full methodology &rarr;
        </a>
      </p>
    </div>
  );
}
