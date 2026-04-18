"use client";

import { useEffect, useRef, useState } from "react";

// Synthetic but realistic ~100-line TypeScript file content
const RAW_CONTENT = `import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import path from "path";

export interface GenomeEntry {
  id: string;
  symbol: string;
  file: string;
  line: number;
  kind: "function" | "class" | "interface" | "type" | "const";
  summary: string;
  tokens: number;
  hash: string;
  updatedAt: number;
}

export interface GenomeIndex {
  version: number;
  rootDir: string;
  entries: GenomeEntry[];
  totalTokens: number;
  lastScan: number;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

export function loadIndex(rootDir: string): GenomeIndex | null {
  const indexPath = path.join(rootDir, ".ashlrcode", "genome", "index.json");
  try {
    const raw = readFileSync(indexPath, "utf8");
    return JSON.parse(raw) as GenomeIndex;
  } catch {
    return null;
  }
}

export function saveIndex(rootDir: string, index: GenomeIndex): void {
  const dir = path.join(rootDir, ".ashlrcode", "genome");
  const indexPath = path.join(dir, "index.json");
  writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");
}

export function mergeEntries(
  existing: GenomeEntry[],
  incoming: GenomeEntry[]
): GenomeEntry[] {
  const map = new Map<string, GenomeEntry>();
  for (const entry of existing) map.set(entry.id, entry);
  for (const entry of incoming) map.set(entry.id, entry);
  return Array.from(map.values()).sort((a, b) => a.file.localeCompare(b.file));
}

export function pruneStale(
  entries: GenomeEntry[],
  rootDir: string
): GenomeEntry[] {
  return entries.filter((e) => {
    try {
      const abs = path.resolve(rootDir, e.file);
      const content = readFileSync(abs, "utf8");
      return hashContent(content) !== e.hash || true;
    } catch {
      return false;
    }
  });
}

export function buildSummaryBlock(entries: GenomeEntry[]): string {
  return entries
    .map((e) => \`[\${e.kind}] \${e.symbol} @ \${e.file}:\${e.line} — \${e.summary}\`)
    .join("\\n");
}

export function estimateTokens(text: string): number {
  // ~3.5 chars per token average for source code
  return Math.ceil(text.length / 3.5);
}

export function findBySymbol(
  entries: GenomeEntry[],
  symbol: string
): GenomeEntry | undefined {
  return entries.find(
    (e) => e.symbol === symbol || e.symbol.endsWith("." + symbol)
  );
}

export function topByTokens(
  entries: GenomeEntry[],
  n = 10
): GenomeEntry[] {
  return [...entries]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, n);
}`.trim();

const SNIP_HEAD = RAW_CONTENT.split("\n").slice(0, 18).join("\n");
const SNIP_TAIL = RAW_CONTENT.split("\n").slice(-8).join("\n");
const ELIDED_BYTES = 3840;
const SNIP_CONTENT = `${SNIP_HEAD}\n\n[... ${ELIDED_BYTES} bytes elided — 61 lines omitted ...]\n\n${SNIP_TAIL}`;

function useCountUp(target: number, duration: number, active: boolean) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!active) return;
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) { setValue(target); return; }
    const start = performance.now();
    let raf: number;
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      // ease-out cubic
      const ease = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * ease));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, target, duration]);
  return value;
}

function formatTokens(n: number) {
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 2).replace(/\.?0+$/, "") + "K";
  return n.toString();
}

function formatBytes(n: number) {
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

interface PanelProps {
  label: string;
  content: string;
  byteCount: number;
  tokenCount: number;
  byteCountLabel: string;
  tokenLabel: string;
  accent: string;
  active: boolean;
}

function Panel({ label, content, byteCount, tokenCount, byteCountLabel, tokenLabel, accent, active }: PanelProps) {
  const bytes = useCountUp(byteCount, 1400, active);
  const tokens = useCountUp(tokenCount, 1600, active);

  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        border: "1px solid var(--ink-10)",
        borderRadius: 6,
        overflow: "hidden",
        background: "var(--paper-deep)",
      }}
    >
      {/* Panel header */}
      <div
        style={{
          padding: "10px 16px",
          background: "var(--paper)",
          borderBottom: "1px solid var(--ink-10)",
          fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--ink-55)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: accent,
            flexShrink: 0,
          }}
        />
        {label}
      </div>

      {/* Code area */}
      <div
        style={{
          flex: 1,
          padding: "14px 16px",
          overflowY: "auto",
          maxHeight: 260,
          fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
          fontSize: 11,
          lineHeight: 1.65,
          color: "var(--ink-55)",
          whiteSpace: "pre",
          overflowX: "auto",
        }}
      >
        {content}
      </div>

      {/* Byte/token count footer */}
      <div
        style={{
          padding: "10px 16px",
          borderTop: "1px solid var(--ink-10)",
          background: "var(--paper)",
          display: "flex",
          alignItems: "baseline",
          gap: 10,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: accent,
            fontVariantNumeric: "tabular-nums",
            transition: "color 0.3s",
          }}
        >
          {byteCountLabel}
        </span>
        <span
          style={{
            fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
            fontSize: 11,
            color: "var(--ink-30)",
            letterSpacing: "0.04em",
          }}
        >
          {formatBytes(bytes)} · {formatTokens(tokens)} tokens
        </span>
      </div>
    </div>
  );
}

export default function BeforeAfter() {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setActive(true); },
      { threshold: 0.2 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <section ref={ref} className="wrap" style={{ paddingTop: 64, paddingBottom: 64 }}>
      {/* Section header */}
      <div className="eyebrow" style={{ marginBottom: 12 }}>Token comparison</div>
      <h2
        style={{
          fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
          fontWeight: 300,
          fontSize: "clamp(22px, 3vw, 34px)",
          lineHeight: 1.25,
          letterSpacing: "-0.02em",
          color: "var(--ink)",
          marginBottom: 32,
          maxWidth: 560,
          fontVariationSettings: '"opsz" 36',
        }}
      >
        The same file. 79% fewer tokens.
      </h2>

      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "stretch",
          flexWrap: "wrap",
        }}
      >
        <Panel
          label="Without ashlr — raw Read"
          content={RAW_CONTENT}
          byteCount={102400}
          tokenCount={25000}
          byteCountLabel="100 KB"
          tokenLabel="25K"
          accent="#8B2E1A"
          active={active}
        />
        <Panel
          label="With ashlr — ashlr__read snipCompact"
          content={SNIP_CONTENT}
          byteCount={21504}
          tokenCount={5250}
          byteCountLabel="21 KB"
          tokenLabel="5.25K"
          accent="#4F5B3F"
          active={active}
        />
      </div>

      {/* Savings callout */}
      <div
        style={{
          marginTop: 20,
          fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
          fontSize: 11,
          color: "var(--ink-30)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        snipCompact: head + tail, middle elided — exact bytes shown in-place
      </div>
    </section>
  );
}
