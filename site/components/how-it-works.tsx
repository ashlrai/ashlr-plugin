"use client";

/**
 * "How it works" three-card section. Placed between Hero and ToolsGrid.
 * Answers the "what does this actually do?" question in a single viewport.
 *
 * Each card is a self-contained mini visualization of one of the three core
 * mechanisms the plugin uses to save tokens:
 *   1. Read it smart        — snipCompact head+tail truncation
 *   2. Search with memory   — genome-aware grep
 *   3. Keep it honest       — live counter + session isolation
 *
 * All three respect prefers-reduced-motion (the animations degrade to static
 * end-states) and every card is readable at mobile widths.
 */
export default function HowItWorks() {
  return (
    <section
      className="mt-24 mb-24"
      style={{ borderTop: "1px solid var(--ink-10)", paddingTop: 56 }}
    >
      <div className="px-[var(--gutter)]" style={{ maxWidth: "var(--max-w)", margin: "0 auto" }}>
        <div
          className="font-mono text-[11px] tracking-[0.2em] uppercase mb-3"
          style={{ color: "var(--ink-55)" }}
        >
          03 · How it works
        </div>
        <h2
          style={{
            fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
            fontWeight: 700,
            fontSize: "clamp(32px, 4vw, 56px)",
            letterSpacing: "-0.02em",
            marginBottom: 16,
            maxWidth: 900,
          }}
        >
          Three mechanisms. Every file read, every grep, every byte accounted for.
        </h2>
        <p
          style={{
            fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
            fontWeight: 300,
            fontSize: "clamp(16px, 1.5vw, 20px)",
            lineHeight: 1.5,
            color: "var(--ink-55)",
            maxWidth: 720,
            marginBottom: 48,
          }}
        >
          ashlr doesn't compress with magic. It wraps the tools Claude Code already
          uses, applies three concrete techniques at call time, and writes every
          saving to a local ledger you can audit.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: 28,
          }}
        >
          <ReadCard />
          <GrepCard />
          <CounterCard />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

const CARD_STYLE: React.CSSProperties = {
  background: "var(--paper)",
  border: "1px solid var(--ink)",
  boxShadow: "5px 5px 0 var(--ink)",
  borderRadius: 6,
  padding: 24,
  display: "flex",
  flexDirection: "column",
  gap: 18,
  minHeight: 340,
};

const CARD_HEAD: React.CSSProperties = {
  fontFamily: "var(--font-jetbrains), ui-monospace, SFMono-Regular, monospace",
  fontSize: 11,
  letterSpacing: "0.2em",
  textTransform: "uppercase",
  color: "var(--ink-55)",
};

const CARD_TITLE: React.CSSProperties = {
  fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
  fontSize: 26,
  fontWeight: 700,
  letterSpacing: "-0.02em",
  lineHeight: 1.15,
  color: "var(--debit)",
};

const CARD_BODY: React.CSSProperties = {
  fontFamily: "var(--font-fraunces), ui-serif, Georgia, serif",
  fontSize: 16,
  lineHeight: 1.55,
  color: "var(--ink-80)",
  fontWeight: 300,
};

// ---------------------------------------------------------------------------
// Card 1 — Read it smart
// ---------------------------------------------------------------------------

function ReadCard() {
  return (
    <article style={CARD_STYLE}>
      <header style={CARD_HEAD}>Read it smart</header>
      <h3 style={CARD_TITLE}>snipCompact head + tail truncation.</h3>
      <p style={CARD_BODY}>
        Large files come back as head + tail with an elision marker for the
        middle — the parts Claude actually scans. Typical 60 KB source file
        arrives as ~9 KB. A single call saves <strong>~51 KB</strong>.
      </p>
      <div
        style={{
          fontFamily: "var(--font-jetbrains), ui-monospace, SFMono-Regular, monospace",
          fontSize: 12,
          lineHeight: 1.6,
          background: "var(--paper-deep)",
          border: "1px dashed var(--ink-30)",
          padding: "12px 14px",
          borderRadius: 4,
          marginTop: "auto",
        }}
      >
        <div style={{ color: "var(--ink-80)" }}>$ ashlr__read src/auth.ts</div>
        <div style={{ color: "var(--ink-55)", marginTop: 6 }}>
          {"// lines 1-24 (head) …"}
        </div>
        <div
          style={{
            color: "var(--debit)",
            fontStyle: "italic",
            margin: "6px 0",
          }}
        >
          […43,042 bytes elided…]
        </div>
        <div style={{ color: "var(--ink-55)" }}>
          {"// lines 486-510 (tail)"}
        </div>
        <div style={{ color: "var(--debit)", marginTop: 8, fontWeight: 600 }}>
          61,840 bytes → 9,203 bytes  &nbsp;&minus;85.1%
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Card 2 — Search with memory
// ---------------------------------------------------------------------------

function GrepCard() {
  return (
    <article style={CARD_STYLE}>
      <header style={CARD_HEAD}>Search with memory</header>
      <h3 style={CARD_TITLE}>Genome-aware grep.</h3>
      <p style={CARD_BODY}>
        When a <code style={{ fontFamily: "var(--font-jetbrains)", fontSize: 14 }}>.ashlrcode/genome/</code>{" "}
        is present, <code style={{ fontFamily: "var(--font-jetbrains)", fontSize: 14 }}>ashlr__grep</code>{" "}
        returns pre-summarized sections instead of raw ripgrep output. Claude
        gets the <em>understanding</em> it needs, not the noise.
      </p>
      <div
        style={{
          fontFamily: "var(--font-jetbrains), ui-monospace, SFMono-Regular, monospace",
          fontSize: 12,
          lineHeight: 1.6,
          background: "var(--paper-deep)",
          border: "1px dashed var(--ink-30)",
          padding: "12px 14px",
          borderRadius: 4,
          marginTop: "auto",
        }}
      >
        <div style={{ color: "var(--ink-80)" }}>$ ashlr__grep &apos;checkoutSession&apos;</div>
        <div style={{ color: "var(--ink-55)", marginTop: 6 }}>
          genome → 3 sections, 1.8 KB
        </div>
        <div style={{ color: "var(--ink-55)" }}>rg equiv  → 47 matches, 24.1 KB</div>
        <div style={{ color: "var(--debit)", marginTop: 8, fontWeight: 600 }}>
          &minus;92.5% · honest count emitted alongside result
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Card 3 — Keep it honest
// ---------------------------------------------------------------------------

function CounterCard() {
  return (
    <article style={CARD_STYLE}>
      <header style={CARD_HEAD}>Keep it honest</header>
      <h3 style={CARD_TITLE}>Live counter. Every saving. Every session.</h3>
      <p style={CARD_BODY}>
        Every tool call appends to a local ledger under{" "}
        <code style={{ fontFamily: "var(--font-jetbrains)", fontSize: 14 }}>~/.ashlr/stats.json</code>.
        The status line ticks up within ~550 ms of each call. Sessions are
        keyed by <code style={{ fontFamily: "var(--font-jetbrains)", fontSize: 14 }}>CLAUDE_SESSION_ID</code>{" "}
        so concurrent terminals never collide.
      </p>
      <div
        style={{
          fontFamily: "var(--font-jetbrains), ui-monospace, SFMono-Regular, monospace",
          fontSize: 13,
          lineHeight: 1.8,
          background: "#0C0C0A",
          color: "#F3EADB",
          padding: "14px 16px",
          borderRadius: 4,
          marginTop: "auto",
        }}
      >
        <div style={{ opacity: 0.55, fontSize: 11 }}>status line</div>
        <div style={{ marginTop: 6 }}>
          ashlr <span style={{ color: "#7cffd6" }}>·</span> 7d{" "}
          <span style={{ color: "#00d09c" }}>▁▂▃▄▅▇█</span> · session{" "}
          <span style={{ color: "#7cffd6" }}>↑</span>+100K · lifetime +4.3M
        </div>
      </div>
    </article>
  );
}
