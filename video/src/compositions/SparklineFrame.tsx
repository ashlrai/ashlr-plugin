import { useCurrentFrame, useVideoConfig } from "remotion";
import {
  sparklineCells,
  type Capability,
} from "../../../servers/_status-line-cells";
import { fontMono, terminalBg } from "../theme";
import { frameToActivity } from "../utils/frame-to-activity";
import session from "../fixtures/hero-session.json";

const TRUECOLOR: Capability = { truecolor: true, unicode: true, animate: true };

interface SparklineFrameProps {
  /** Which sparkline to render. */
  series: "sparkline7d" | "sparkline30d";
  /** Label shown to the left of the sparkline (e.g. "7d" / "30d"). */
  label: string;
  /** Visual scale multiplier. */
  scale?: number;
}

/**
 * Stand-alone sparkline renderer for the B4 dashboard beat. Uses the exact
 * same sparklineCells() the CLI + hero status line consume, so the visual
 * shimmer is consistent across the whole video.
 */
export const SparklineFrame: React.FC<SparklineFrameProps> = ({
  series,
  label,
  scale = 1,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { clFrame, msSinceActive } = frameToActivity(frame, fps, session.activityEvents);

  const values = session[series];
  const cells = sparklineCells({
    values,
    frame: clFrame,
    msSinceActive,
    cap: TRUECOLOR,
  });

  return (
    <div
      style={{
        fontFamily: fontMono,
        fontSize: 22 * scale,
        color: terminalBg,
        display: "flex",
        alignItems: "center",
        gap: 12 * scale,
      }}
    >
      <span style={{ opacity: 0.55, width: 30 * scale }}>{label}</span>
      <span style={{ whiteSpace: "pre", letterSpacing: 1 * scale }}>
        {cells.map((c, i) => (
          <span
            key={i}
            style={{
              color: c.fg ? `rgb(${c.fg.r}, ${c.fg.g}, ${c.fg.b})` : undefined,
              display: "inline-block",
            }}
          >
            {c.char}
          </span>
        ))}
      </span>
    </div>
  );
};
