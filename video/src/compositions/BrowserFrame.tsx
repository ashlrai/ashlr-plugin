import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { debit, debitDeep, fontMono, fontSerif, inkFaint, inkMid, inkSoft, paper, paperDeep } from "../theme";

/**
 * B5 first 4 seconds — a simulated browser-chrome frame containing a mock-up
 * of the plugin.ashlr.ai landing page. We reproduce the chrome (traffic
 * lights + URL bar) and the landing-page hero layout in native Remotion, so
 * no Playwright screenshot step is needed and CI can re-render deterministically.
 *
 * Motion: slow scale from 1.04 → 1.0 over the full 240-frame window with a
 * subtle vertical pan (parallax-style) so the page "settles" into view.
 */
export const BrowserFrame: React.FC = () => {
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 240], [1.04, 1.0], {
    extrapolateRight: "clamp",
  });
  const pan = interpolate(frame, [0, 240], [-18, 0], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: paperDeep, padding: 60, transform: `scale(${scale})`, transformOrigin: "center center" }}>
      <div
        style={{
          background: paper,
          border: `1px solid ${inkSoft}`,
          borderRadius: 10,
          boxShadow: "0 24px 60px rgba(18,18,18,0.12), 8px 8px 0 rgba(18,18,18,0.85)",
          overflow: "hidden",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          transform: `translateY(${pan}px)`,
        }}
      >
        {/* Browser chrome */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 18px",
            background: paperDeep,
            borderBottom: `1px solid ${inkFaint}`,
          }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <Dot color="#FF605C" />
            <Dot color="#FFBD44" />
            <Dot color="#00CA4E" />
          </div>
          <div
            style={{
              flex: 1,
              background: paper,
              border: `1px solid ${inkFaint}`,
              borderRadius: 20,
              padding: "8px 16px",
              fontFamily: fontMono,
              fontSize: 14,
              color: inkMid,
              textAlign: "center",
              maxWidth: 520,
              margin: "0 auto",
            }}
          >
            plugin.ashlr.ai
          </div>
          <div style={{ width: 44 }} />
        </div>

        {/* Page body — mirrors the real landing hero layout */}
        <div
          style={{
            flex: 1,
            padding: "64px 72px",
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 48,
            alignItems: "center",
          }}
        >
          <div>
            <div
              style={{
                fontFamily: fontMono,
                fontSize: 13,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: inkMid,
                marginBottom: 18,
              }}
            >
              The token ledger for Claude Code
            </div>
            <div
              style={{
                fontFamily: fontSerif,
                fontSize: 64,
                fontWeight: 700,
                color: debit,
                letterSpacing: "-0.02em",
                lineHeight: 1.02,
                marginBottom: 20,
              }}
            >
              ship less context.
            </div>
            <div
              style={{
                fontFamily: fontSerif,
                fontSize: 22,
                color: inkSoft,
                marginBottom: 36,
                lineHeight: 1.5,
              }}
            >
              Open-source. 19 MCP tools. 71.3% mean savings measured to the byte.
            </div>

            <div style={{ display: "flex", gap: 12 }}>
              <Cta primary>Install</Cta>
              <Cta>Benchmarks</Cta>
            </div>

            <div
              style={{
                fontFamily: fontMono,
                fontSize: 12,
                color: inkMid,
                marginTop: 36,
                letterSpacing: "0.1em",
              }}
            >
              MIT · GitHub · +1.2k installs this week
            </div>
          </div>

          {/* Right: a stamped "-71.3%" ledger card — the visual payoff */}
          <div
            style={{
              background: paper,
              border: `2px solid ${debit}`,
              borderRadius: 10,
              padding: "40px 40px 36px",
              transform: "rotate(-1.6deg)",
              boxShadow: "10px 10px 0 rgba(139,46,26,0.18)",
              position: "relative",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 16,
                right: 20,
                fontFamily: fontMono,
                fontSize: 10,
                letterSpacing: "0.2em",
                color: debitDeep,
                textTransform: "uppercase",
              }}
            >
              AUDITED · MIT · 2026
            </div>
            <div
              style={{
                fontFamily: fontMono,
                fontSize: 12,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: inkMid,
                marginBottom: 8,
              }}
            >
              measured savings
            </div>
            <div
              style={{
                fontFamily: fontSerif,
                fontSize: 128,
                fontWeight: 700,
                color: debit,
                letterSpacing: "-0.04em",
                lineHeight: 0.95,
              }}
            >
              −71.3%
            </div>
            <div
              style={{
                fontFamily: fontSerif,
                fontStyle: "italic",
                fontSize: 20,
                color: debitDeep,
                marginTop: 14,
              }}
            >
              on files ≥ 2 KB
            </div>
            <div
              style={{
                fontFamily: fontMono,
                fontSize: 12,
                color: inkMid,
                marginTop: 20,
                letterSpacing: "0.08em",
              }}
            >
              337 files · 56.9K LOC · reproducible via bun run bench
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const Dot: React.FC<{ color: string }> = ({ color }) => (
  <span
    style={{
      width: 13,
      height: 13,
      borderRadius: "50%",
      background: color,
      display: "inline-block",
    }}
  />
);

const Cta: React.FC<{ primary?: boolean; children: React.ReactNode }> = ({ primary, children }) => (
  <span
    style={{
      fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
      fontSize: 16,
      padding: "12px 24px",
      border: `1px solid ${primary ? debit : "rgba(18,18,18,0.85)"}`,
      background: primary ? debit : "transparent",
      color: primary ? paper : "rgba(18,18,18,0.85)",
      borderRadius: 4,
      boxShadow: primary
        ? "3px 3px 0 rgba(94,30,17,0.5)"
        : "3px 3px 0 rgba(18,18,18,0.9)",
      letterSpacing: "0.02em",
    }}
  >
    {children}
  </span>
);
