import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { fontMono, terminalBg, terminalFg } from "../theme";

interface TypedTerminalProps {
  /** Full content to reveal over the duration of the beat. */
  content: string;
  /** Beat start frame (relative to composition). */
  startFrame: number;
  /** Beat end frame. Content fully visible by this point. */
  endFrame: number;
  /** Optional label rendered in the bottom-left corner. */
  caption?: string;
  /** Frame at which the caption fades in. Defaults to (start + 20). */
  captionAtFrame?: number;
}

/**
 * A terminal frame that types `content` character-by-character between
 * `startFrame` and `endFrame`. The cursor blinks at every 24-frame cycle
 * until the content is fully revealed; after that it parks to the right of
 * the last line.
 */
export const TypedTerminal: React.FC<TypedTerminalProps> = ({
  content,
  startFrame,
  endFrame,
  caption,
  captionAtFrame,
}) => {
  const frame = useCurrentFrame();
  const progress = interpolate(
    frame,
    [startFrame, endFrame],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const revealed = content.slice(0, Math.floor(content.length * progress));
  const cursor = Math.floor(frame / 12) % 2 === 0 ? "▋" : " ";
  const captionStart = captionAtFrame ?? startFrame + 20;
  const captionOpacity = interpolate(
    frame,
    [captionStart, captionStart + 12],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill
      style={{
        background: terminalBg,
        color: terminalFg,
        fontFamily: fontMono,
        fontSize: 26,
        lineHeight: 1.45,
        padding: 60,
        whiteSpace: "pre-wrap",
      }}
    >
      <div>
        {revealed}
        <span style={{ opacity: 0.85 }}>{cursor}</span>
      </div>
      {caption && (
        <div
          style={{
            position: "absolute",
            bottom: 32,
            left: 60,
            fontFamily: fontMono,
            fontSize: 20,
            color: "rgba(243, 234, 219, 0.55)",
            opacity: captionOpacity,
          }}
        >
          {caption}
        </div>
      )}
    </AbsoluteFill>
  );
};
