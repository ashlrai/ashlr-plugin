/**
 * /og — query-parametrized Open Graph image generator.
 *
 * GET /og?title=...&eyebrow=...&desc=...  → 1200×630 PNG in the ashlr "ledger"
 * style with the given title. Referenced from per-page `generateMetadata`
 * (e.g. docs pages) so every page gets a unique social card without an
 * opengraph-image file under an optional catch-all segment (which Next forbids).
 */
import { ImageResponse } from "next/og";

export const runtime = "edge";

export function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const title = (searchParams.get("title") ?? "ashlr").slice(0, 140);
  const eyebrow = (searchParams.get("eyebrow") ?? "The Token Ledger").slice(0, 40);
  const desc = (searchParams.get("desc") ?? "").slice(0, 160);

  const titleSize = title.length > 48 ? 56 : title.length > 28 ? 68 : 80;

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
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(ellipse at 80% 10%, #ECE2CE 0%, transparent 60%)",
            opacity: 0.6,
          }}
        />

        <div style={{ display: "flex", alignItems: "baseline", gap: 24 }}>
          <span style={{ fontSize: 36, fontWeight: 300, letterSpacing: "-0.02em", color: "#121212" }}>
            ashlr
          </span>
          <div style={{ width: 1, height: 28, background: "#D9CDB3", marginLeft: 4 }} />
          <span
            style={{
              fontFamily: "monospace",
              fontSize: 11,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "#8B2E1A",
            }}
          >
            {eyebrow}
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20, marginTop: -20 }}>
          <span
            style={{
              fontSize: titleSize,
              fontWeight: 300,
              lineHeight: 1.0,
              letterSpacing: "-0.035em",
              color: "#121212",
              fontStyle: "italic",
              maxWidth: 960,
            }}
          >
            {title}
          </span>
          {desc ? (
            <span
              style={{
                fontFamily: "monospace",
                fontSize: 20,
                letterSpacing: "0.02em",
                color: "rgba(18,18,18,0.55)",
                marginTop: 8,
                maxWidth: 960,
                lineHeight: 1.3,
              }}
            >
              {desc}
            </span>
          ) : null}
        </div>

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
            curl -fsSL https://plugin.ashlr.ai/install.sh | bash
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
    { width: 1200, height: 630 },
  );
}
