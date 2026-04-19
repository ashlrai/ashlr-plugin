import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { BrowserFrame } from "./BrowserFrame";
import { DashboardFrame } from "./DashboardFrame";
import { StatusLineStill } from "./StatusLineStill";
import { TypedTerminal } from "./TypedTerminal";
import { TaglineCard } from "./TaglineCard";
import { fontMono, paper, terminalBg, terminalDim } from "../theme";

/**
 * Hero video composition — 30 seconds at 1920x1080 @ 60 fps.
 *
 * Five beats per docs/hero-video-script.md:
 *   B1 0–5 s   | `/ashlr-savings` typewriter            (frames 0–300)
 *   B2 5–10 s  | Status-line zoom + parchment plate     (frames 300–600)
 *   B3 10–15 s | Live edit counter + diff pane          (frames 600–900)
 *   B4 15–20 s | `/ashlr-dashboard` CountUp tiles       (frames 900–1200)
 *   B5 20–30 s | Browser pan + install + tagline        (frames 1200–1800)
 *
 * This file is the framing shell. Each beat component lives in its own file
 * and is composed via <Sequence>. Total runtime = 1800 frames = 30 s.
 */
export const HeroVideo: React.FC = () => {
  useVideoConfig();
  return (
    <AbsoluteFill style={{ background: paper }}>
      <Sequence from={0} durationInFrames={300}>
        <Beat1Savings />
      </Sequence>
      <Sequence from={300} durationInFrames={300}>
        <Beat2StatusLine />
      </Sequence>
      <Sequence from={600} durationInFrames={300}>
        <Beat3EditCounter />
      </Sequence>
      <Sequence from={900} durationInFrames={300}>
        <Beat4Dashboard />
      </Sequence>
      <Sequence from={1200} durationInFrames={600}>
        <Beat5BrowserInstallTagline />
      </Sequence>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Beat 1 — /ashlr-savings typewriter
// ---------------------------------------------------------------------------

const SAVINGS_DASHBOARD = `$ /ashlr-savings

ashlr · savings report
─────────────────────────────────────────
session          ↑ +100,303 tokens
lifetime         +4,318,742 tokens
best day         +412,300 tokens  (Apr 16)

per tool
  ashlr__read    ───────────────────  -79.5 %  (31,240)
  ashlr__grep    ─────────────        -62.1 %  (18,400)
  ashlr__bash    ────────             -44.8 %  (14,300)
  ashlr__edit    ────────────────     -71.2 %  (12,900)
  ashlr__diff    ──────────           -54.3 %   (8,900)

last 7 days   ▁▂▃▄▅▇█▆▅▃
`;

const Beat1Savings: React.FC = () => (
  <AbsoluteFill style={{ background: terminalBg }}>
    <TypedTerminal
      content={SAVINGS_DASHBOARD}
      startFrame={0}
      endFrame={240}
      caption="/ashlr-savings"
      captionAtFrame={60}
    />
  </AbsoluteFill>
);

// ---------------------------------------------------------------------------
// Beat 2 — Status line zoom (native Remotion status-line render)
// ---------------------------------------------------------------------------

const Beat2StatusLine: React.FC = () => (
  <AbsoluteFill
    style={{
      background: terminalBg,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    <StatusLineStill scale={1.8} />
    <div
      style={{
        position: "absolute",
        bottom: 60,
        fontFamily: fontMono,
        fontSize: 20,
        color: terminalDim,
      }}
    >
      live session counter · 7-day sparkline
    </div>
  </AbsoluteFill>
);

// ---------------------------------------------------------------------------
// Beat 3 — Live edit counter (stub — expanded in Task #15)
// ---------------------------------------------------------------------------

const Beat3EditCounter: React.FC = () => (
  <AbsoluteFill
    style={{
      background: terminalBg,
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 24,
      padding: 60,
    }}
  >
    <div style={{ color: paper, fontFamily: fontMono, fontSize: 22 }}>
      <div style={{ opacity: 0.55, marginBottom: 12 }}>$ ashlr__edit</div>
      <pre style={{ margin: 0 }}>{`  src/auth.ts
  @@ -12,7 +12,14 @@
  - if (user) return user;
  + if (user) {
  +   logger.info({ user_id: user.id }, "session resumed");
  +   return user;
  + }`}</pre>
    </div>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      <StatusLineStill scale={1} />
    </div>
  </AbsoluteFill>
);

// ---------------------------------------------------------------------------
// Beat 4 — /ashlr-dashboard (real ledger dashboard with CountUp tiles,
// animated bar chart fills, live sparklines, projected-annual line)
// ---------------------------------------------------------------------------

const Beat4Dashboard: React.FC = () => <DashboardFrame />;

// ---------------------------------------------------------------------------
// Beat 5 — Browser + install + tagline (stub — browser pan in Task #15 + #16)
// ---------------------------------------------------------------------------

const INSTALL_TEXT = `$ curl -fsSL plugin.ashlr.ai/install.sh | bash

› detecting platform:     darwin-arm64
› fetching marketplace:   ashlr-marketplace  ✓
› installing plugin:      ashlr              ✓
› hooking session-start:                      ✓
› writing ~/.ashlr/env:                       ✓

ashlr-plugin v1.11.0 installed. Restart Claude Code to activate.
`;

const Beat5BrowserInstallTagline: React.FC = () => (
  <>
    <Sequence from={0} durationInFrames={240}>
      <BrowserFrame />
    </Sequence>
    <Sequence from={240} durationInFrames={180}>
      <AbsoluteFill style={{ background: terminalBg }}>
        <TypedTerminal content={INSTALL_TEXT} startFrame={0} endFrame={160} />
      </AbsoluteFill>
    </Sequence>
    <Sequence from={420} durationInFrames={180}>
      <TaglineCard startFrame={0} endFrame={180} />
    </Sequence>
  </>
);
