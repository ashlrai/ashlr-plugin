import { AbsoluteFill, interpolate, staticFile, useCurrentFrame } from "remotion";
import { debit, fontSerif, paper } from "../theme";

interface TaglineCardProps {
  startFrame: number;
  endFrame: number;
}

/**
 * The final "ship less context." tagline card. Fades in over 30 frames, holds,
 * then fades to black over the final 60 frames of the video.
 *
 * If the user-generated parchment plate at video/public/plates/b5-tagline.png
 * is present, it is layered behind the type with 40% opacity. If not, we
 * fall back to a flat parchment color — the card still looks intentional.
 */
export const TaglineCard: React.FC<TaglineCardProps> = ({ startFrame, endFrame }) => {
  const frame = useCurrentFrame();
  const fadeInEnd = startFrame + 30;
  const fadeOutStart = endFrame - 60;
  const opacity = interpolate(
    frame,
    [startFrame, fadeInEnd, fadeOutStart, endFrame],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const plate = safeStaticFile("plates/b5-tagline.png");

  return (
    <AbsoluteFill style={{ background: "#000000", opacity }}>
      <AbsoluteFill style={{ background: paper }}>
        {plate && (
          <img
            src={plate}
            alt=""
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              opacity: 0.55,
              mixBlendMode: "multiply",
            }}
          />
        )}
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: fontSerif,
            fontStyle: "italic",
            fontSize: 160,
            color: debit,
            letterSpacing: "-0.02em",
            textShadow: "0 2px 0 rgba(94, 30, 17, 0.12)",
          }}
        >
          ship less context.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

function safeStaticFile(path: string): string | null {
  try {
    return staticFile(path);
  } catch {
    return null;
  }
}
