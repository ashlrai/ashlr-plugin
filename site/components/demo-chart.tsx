"use client";

import { useEffect, useRef, useState } from "react";
import { benchmarkRows, benchmarkSummary } from "@/lib/tools";

const MAX_TOKENS = 3000;

function Bar({
  label,
  tokens,
  maxTokens,
  color,
  inView,
  delay = 0,
}: {
  label: string;
  tokens: number;
  maxTokens: number;
  color: string;
  inView: boolean;
  delay?: number;
}) {
  const pct = (tokens / maxTokens) * 100;

  return (
    <div className="flex items-center gap-3 min-w-0">
      <div
        className="font-mono text-[11px] shrink-0"
        style={{ width: 120, color: "var(--ink-55)", textAlign: "right" }}
      >
        {tokens.toLocaleString()}
      </div>
      <div className="flex-1 relative h-5" style={{ background: "var(--ink-10)" }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: inView ? `${pct}%` : "0%",
            background: color,
            transition: inView
              ? `width 0.9s cubic-bezier(0.25, 1, 0.4, 1) ${delay}ms`
              : "none",
          }}
        />
      </div>
      <span
        className="font-mono text-[11px] shrink-0"
        style={{ color: "var(--ink-55)", minWidth: 80 }}
      >
        {label}
      </span>
    </div>
  );
}

export default function DemoChart() {
  const [inView, setInView] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setInView(true); },
      { threshold: 0.15 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <section
      ref={ref}
      style={{ padding: "96px 0", borderTop: "1px solid var(--ink-10)" }}
    >
      <div className="wrap">
        <div className="eyebrow">
          <span
            className="font-mono text-[10px] border px-2 py-0.5"
            style={{ borderColor: "var(--ink-30)", color: "var(--ink)" }}
          >
            03
          </span>
          Benchmark
        </div>

        <h2 className="section-head mb-3" style={{ maxWidth: 680 }}>
          See it save{" "}
          <span className="italic-accent">tokens.</span>
        </h2>

        <p
          className="mb-14"
          style={{
            fontFamily: "var(--font-fraunces), ui-serif",
            fontSize: 20,
            color: "var(--ink-55)",
            maxWidth: 560,
            lineHeight: 1.45,
            fontVariationSettings: '"opsz" 32',
          }}
        >
          Reproducible against your own codebase:{" "}
          <code className="font-mono text-[14px]">bun run bench</code>. Numbers
          below from the ashlr-plugin source repo.
        </p>

        {/* Hero stat */}
        <div className="ledger-card inline-flex items-baseline gap-4 px-8 py-5 mb-14">
          <span
            className="font-mono tabular-nums"
            style={{ fontSize: "clamp(40px, 6vw, 64px)", color: "var(--debit)", fontWeight: 600, lineHeight: 1 }}
          >
            &minus;{benchmarkSummary.savingsPct}%
          </span>
          <span
            className="font-mono text-[12px] tracking-[0.1em] uppercase"
            style={{ color: "var(--ink-55)" }}
          >
            {benchmarkSummary.label}
          </span>
        </div>

        {/* Before / after summary bar */}
        <div className="ledger-card overflow-hidden mb-12" style={{ maxWidth: 720 }}>
          <div
            className="flex items-center justify-between px-5 py-3 border-b border-[var(--ink-10)]"
            style={{ background: "var(--paper)" }}
          >
            <span className="mono-label">Tokens per read · large file</span>
          </div>
          <div className="p-5 space-y-4" style={{ background: "var(--paper-deep)" }}>
            <Bar
              label="without ashlr"
              tokens={100000}
              maxTokens={105000}
              color="var(--ink-30)"
              inView={inView}
              delay={0}
            />
            <Bar
              label="with ashlr"
              tokens={20500}
              maxTokens={105000}
              color="var(--debit)"
              inView={inView}
              delay={200}
            />
          </div>
        </div>

        {/* Per-file breakdown */}
        <div className="ledger-card overflow-hidden" style={{ maxWidth: 760 }}>
          <div
            className="flex items-center justify-between px-5 py-3 border-b border-[var(--ink-10)]"
            style={{ background: "var(--paper)" }}
          >
            <span className="mono-label">File-by-file breakdown</span>
            <span className="mono-label">saved %</span>
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
              {/* Mini bar */}
              <div
                className="shrink-0 relative h-2"
                style={{ width: 120, background: "var(--ink-10)" }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: inView ? `${row.savedPct}%` : "0%",
                    background: "var(--debit)",
                    transition: inView
                      ? `width 0.8s cubic-bezier(0.25, 1, 0.4, 1) ${i * 120 + 300}ms`
                      : "none",
                  }}
                />
              </div>
              <span
                className="font-mono text-[12px] tabular-nums shrink-0"
                style={{ color: "var(--debit)", minWidth: 50, textAlign: "right" }}
              >
                &minus;{row.savedPct}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
