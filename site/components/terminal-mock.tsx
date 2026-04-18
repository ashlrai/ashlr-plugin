"use client";

import { useEffect, useState } from "react";

// Sparkline chars — animate cycling through levels
const SPARK_CHARS = ["▁", "▂", "▃", "▅", "▇", "█"];

// Each cell cycles at different offsets for an organic feel
const CELL_OFFSETS = [0, 1, 2, 3, 4, 5, 4, 3];

function SparklineCell({ frameIndex, cellIndex }: { frameIndex: number; cellIndex: number }) {
  const idx = (frameIndex + CELL_OFFSETS[cellIndex]) % SPARK_CHARS.length;
  const char = SPARK_CHARS[idx];
  // Color intensity based on position in cycle
  const intensity = idx / (SPARK_CHARS.length - 1);
  const opacity = 0.3 + intensity * 0.7;

  return (
    <span
      style={{
        color: `rgba(79, 91, 63, ${opacity})`,
        transition: "color 0.4s ease",
      }}
    >
      {char}
    </span>
  );
}

export default function TerminalMock() {
  const [frameIndex, setFrameIndex] = useState(0);
  const [prefersReduced, setPrefersReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReduced(mq.matches);
    if (mq.matches) return;

    const interval = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % SPARK_CHARS.length);
    }, 400);

    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className="ledger-card overflow-hidden"
      role="img"
      aria-label="ashlr terminal status output"
    >
      {/* Window chrome */}
      <div
        className="flex items-center gap-2 px-4 py-3 border-b border-[var(--ink-10)]"
        style={{ background: "var(--paper)" }}
      >
        <span
          className="w-2.5 h-2.5 rounded-full"
          style={{ background: "var(--debit)", opacity: 0.7 }}
        />
        <span
          className="w-2.5 h-2.5 rounded-full"
          style={{ background: "var(--ink-30)" }}
        />
        <span
          className="w-2.5 h-2.5 rounded-full"
          style={{ background: "var(--ink-30)" }}
        />
        <span
          className="ml-auto font-mono text-[10px] tracking-[0.14em] uppercase"
          style={{ color: "var(--ink-30)" }}
        >
          ashlr · status
        </span>
      </div>

      {/* Terminal body */}
      <div className="px-5 py-4 font-mono text-[13px] leading-relaxed" style={{ background: "var(--paper-deep)" }}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* Brand */}
          <span style={{ color: "var(--debit)", fontWeight: 600 }}>ashlr</span>
          <span style={{ color: "var(--ink-30)" }}>·</span>

          {/* 7d label */}
          <span style={{ color: "var(--ink-55)" }}>7d</span>

          {/* Animated sparkline */}
          <span aria-hidden="true">
            {CELL_OFFSETS.map((_, i) => (
              <SparklineCell
                key={i}
                frameIndex={prefersReduced ? SPARK_CHARS.length - 1 : frameIndex}
                cellIndex={i}
              />
            ))}
          </span>

          <span style={{ color: "var(--ink-30)" }}>·</span>

          {/* Session delta */}
          <span style={{ color: "var(--ink-55)" }}>session</span>
          <span style={{ color: "var(--debit)" }}>&#x2191;+432.5K</span>

          <span style={{ color: "var(--ink-30)" }}>·</span>

          {/* Lifetime */}
          <span style={{ color: "var(--ink-55)" }}>lifetime</span>
          <span style={{ color: "var(--debit)" }}>+4.3M</span>

          <span style={{ color: "var(--ink-30)" }}>·</span>

          {/* Tip */}
          <span style={{ color: "var(--ink-30)" }}>tip:</span>
          <span style={{ color: "var(--credit)" }}>ashlr__edit</span>
          <span style={{ color: "var(--ink-55)" }}>ships diffs</span>
        </div>

        {/* Second line: recent ops */}
        <div className="mt-3 space-y-1.5">
          {[
            { file: "src/genome/retriever.ts", saved: "−1,595 tok", pct: "79.7%" },
            { file: "src/compression/context.ts", saved: "−1,111 tok", pct: "73.2%" },
            { file: "src/genome/generations.ts", saved: "−2,472 tok", pct: "85.9%" },
          ].map((row) => (
            <div key={row.file} className="flex justify-between items-center gap-4">
              <span style={{ color: "var(--ink-30)" }}>ashlr__read</span>
              <span
                className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
                style={{ color: "var(--ink-55)" }}
              >
                {row.file}
              </span>
              <span style={{ color: "var(--debit)", flexShrink: 0, fontWeight: 500 }}>
                {row.saved}
              </span>
              <span
                className="text-[11px]"
                style={{ color: "var(--credit)", flexShrink: 0 }}
              >
                {row.pct}
              </span>
            </div>
          ))}
        </div>

        {/* Cursor blink */}
        <div className="mt-3 flex items-center gap-2">
          <span style={{ color: "var(--debit)" }}>$</span>
          <span
            className="inline-block w-2 h-4 align-middle"
            style={{
              background: "var(--ink-55)",
              animation: prefersReduced ? "none" : "blink 1.2s step-end infinite",
            }}
          />
        </div>
      </div>

      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
