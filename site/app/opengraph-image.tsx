import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "ashlr · The Token Ledger for Claude Code";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Sparkline path: 14-point normalized savings trend (illustrative, not live data)
const SPARK_POINTS = [
  [0, 40], [80, 35], [160, 30], [240, 22], [320, 28],
  [400, 18], [480, 12], [560, 16], [640, 10], [720, 14],
  [800, 8], [880, 11], [960, 6], [1040, 4],
] as [number, number][];

function sparklinePath(points: [number, number][]): string {
  if (points.length === 0) return "";
  const [sx, sy] = points[0];
  const segments = points
    .slice(1)
    .map(([x, y]) => `L ${x} ${y}`)
    .join(" ");
  return `M ${sx} ${sy} ${segments}`;
}

export default async function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 1200,
          height: 630,
          background: "#F3EADB",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px 60px",
          fontFamily: "serif",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Subtle grain overlay — radial gradient approximation */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(ellipse at 80% 10%, #ECE2CE 0%, transparent 60%)",
            opacity: 0.6,
          }}
        />

        {/* Top row: wordmark + eyebrow rule */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 24 }}>
          <span
            style={{
              fontFamily: "serif",
              fontSize: 36,
              fontWeight: 300,
              letterSpacing: "-0.02em",
              color: "#121212",
            }}
          >
            ashlr
          </span>
          <div
            style={{
              width: 1,
              height: 28,
              background: "#D9CDB3",
              marginLeft: 4,
            }}
          />
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 11,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "#8B2E1A",
            }}
          >
            The Token Ledger
          </span>
        </div>

        {/* Main headline */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 20,
            marginTop: -20,
          }}
        >
          <span
            style={{
              fontFamily: "serif",
              fontSize: 80,
              fontWeight: 300,
              lineHeight: 0.95,
              letterSpacing: "-0.035em",
              color: "#121212",
              fontStyle: "italic",
              maxWidth: 820,
            }}
          >
            The Token Ledger for Claude Code
          </span>
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 20,
              letterSpacing: "0.06em",
              color: "#8B2E1A",
              marginTop: 8,
            }}
          >
            -79.5% savings (files ≥ 2 KB) · MIT · Zero telemetry
          </span>
        </div>

        {/* Sparkline — right side */}
        <div
          style={{
            position: "absolute",
            right: 60,
            top: 160,
            display: "flex",
          }}
        >
          <svg
            width="220"
            height="80"
            viewBox="-20 -10 1100 70"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Fill area under sparkline */}
            <path
              d={`${sparklinePath(SPARK_POINTS)} L 1040 60 L 0 60 Z`}
              fill="#8B2E1A"
              opacity="0.10"
            />
            {/* Sparkline stroke */}
            <path
              d={sparklinePath(SPARK_POINTS)}
              stroke="#8B2E1A"
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {/* Terminal dot */}
            <circle cx="1040" cy="4" r="5" fill="#8B2E1A" />
          </svg>
        </div>

        {/* Bottom row: install hint + divider */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: "1px solid #D9CDB3",
            paddingTop: 20,
          }}
        >
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 14,
              letterSpacing: "0.06em",
              color: "rgba(18,18,18,0.50)",
            }}
          >
            claude mcp add ashlr -- npx -y ashlr-plugin
          </span>
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 11,
              letterSpacing: "0.12em",
              color: "#8B2E1A",
              textTransform: "uppercase",
            }}
          >
            plugin.ashlr.ai
          </span>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
