import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { CountUpTile } from "./CountUpTile";
import { SparklineFrame } from "./SparklineFrame";
import { debit, fontSerif, inkMid, paper } from "../theme";
import session from "../fixtures/hero-session.json";

/**
 * B4 — /ashlr-dashboard. Full ledger-card dashboard: a serif wordmark at the
 * top, three CountUp tiles (session/lifetime/best day), a per-tool bar chart
 * with animated width fills, 7d + 30d sparklines, and a projected-annual line
 * in Fraunces italic. All driven off video/src/fixtures/hero-session.json.
 *
 * Intended to play for the full 300-frame (5 s) beat window. The tiles count
 * up simultaneously over the first 90 frames, the bar chart fills over
 * frames 30–150, the sparklines and projected line fade in last.
 */
export const DashboardFrame: React.FC = () => {
  const frame = useCurrentFrame();

  const barFill = (offset: number) =>
    interpolate(frame, [30 + offset, 150 + offset], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  const sparkOpacity = interpolate(frame, [150, 200], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const projectedOpacity = interpolate(frame, [200, 260], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: paper, padding: "80px 120px", fontFamily: fontSerif }}>
      <div
        style={{
          fontFamily: fontSerif,
          fontSize: 46,
          fontWeight: 700,
          color: debit,
          letterSpacing: "-0.02em",
          marginBottom: 8,
        }}
      >
        ashlr · the token ledger for claude code
      </div>
      <div
        style={{
          fontFamily: fontSerif,
          fontSize: 18,
          color: inkMid,
          marginBottom: 40,
          fontStyle: "italic",
        }}
      >
        /ashlr-dashboard
      </div>

      <div style={{ display: "flex", gap: 24, marginBottom: 48 }}>
        <CountUpTile
          label="session"
          target={session.session.tokensSaved}
          durationFrames={90}
          delta="↑ active"
        />
        <CountUpTile
          label="lifetime"
          target={session.lifetime.tokensSaved}
          durationFrames={90}
        />
        <CountUpTile
          label="best day"
          target={session.bestDay.tokensSaved}
          durationFrames={90}
          delta="Apr 16"
        />
      </div>

      <div style={{ marginBottom: 36 }}>
        {session.toolBars.map((bar, i) => (
          <div
            key={bar.name}
            style={{
              display: "grid",
              gridTemplateColumns: "220px 1fr 120px",
              gap: 18,
              alignItems: "center",
              padding: "10px 0",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 20,
            }}
          >
            <span style={{ color: debit }}>{bar.name}</span>
            <div
              style={{
                height: 14,
                background: "rgba(18,18,18,0.08)",
                border: "1px solid rgba(18,18,18,0.2)",
                borderRadius: 2,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${Math.min(100, bar.savedPct) * barFill(i * 8)}%`,
                  height: "100%",
                  background: debit,
                }}
              />
            </div>
            <span style={{ textAlign: "right", color: inkMid }}>
              -{bar.savedPct.toFixed(1)}%
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gap: 10, opacity: sparkOpacity }}>
        <SparklineFrame series="sparkline7d" label="7d" />
        <SparklineFrame series="sparkline30d" label="30d" />
      </div>

      <div
        style={{
          marginTop: 36,
          fontFamily: fontSerif,
          fontStyle: "italic",
          fontSize: 24,
          color: debit,
          opacity: projectedOpacity,
        }}
      >
        projected annual ≈ 52.4 M tokens saved
      </div>
    </AbsoluteFill>
  );
};
