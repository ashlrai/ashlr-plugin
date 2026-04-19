import { useCurrentFrame, useVideoConfig } from "remotion";
import {
  sparklineCells,
  heartbeatCell,
  activityCell,
  type Capability,
  type Cell,
} from "../../../servers/_status-line-cells";
import { fontMono, terminalBg } from "../theme";
import { frameToActivity } from "../utils/frame-to-activity";
import session from "../fixtures/hero-session.json";

const TRUECOLOR_UNICODE: Capability = { truecolor: true, unicode: true, animate: true };

interface StatusLineStillProps {
  /**
   * Visual scale multiplier. Beat 2 blows the line up to hero-fill size; Beat 5
   * uses it at smaller-than-terminal scale for inline landing shots.
   */
  scale?: number;
  /** Override the session payload (defaults to hero-session fixture). */
  sessionLabel?: string;
  lifetimeLabel?: string;
}

/**
 * Renders the live ashlr status line as native Remotion DOM — pixel-for-pixel
 * the same visual decisions the CLI makes, but as styled <span>s instead of
 * ANSI escapes. Uses the exact cell-producing functions from
 * servers/_status-line-cells.ts, so any tweak to the CLI animation
 * automatically flows into the hero video.
 */
export const StatusLineStill: React.FC<StatusLineStillProps> = ({
  scale = 1,
  sessionLabel = session.session.label,
  lifetimeLabel = session.lifetime.label,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { clFrame, msSinceActive } = frameToActivity(frame, fps, session.activityEvents);

  const spark = sparklineCells({
    values: session.sparkline7d,
    frame: clFrame,
    msSinceActive,
    cap: TRUECOLOR_UNICODE,
  });
  const heart = heartbeatCell(clFrame, msSinceActive, TRUECOLOR_UNICODE);
  const activity = activityCell(msSinceActive, TRUECOLOR_UNICODE);

  const cellFont = `${28 * scale}px ${fontMono}`;

  return (
    <div
      style={{
        fontFamily: fontMono,
        fontSize: 28 * scale,
        lineHeight: 1,
        whiteSpace: "pre",
        color: "#F3EADB",
        background: terminalBg,
        padding: `${18 * scale}px ${28 * scale}px`,
        borderRadius: 10 * scale,
        display: "inline-flex",
        alignItems: "center",
        gap: 0,
        font: cellFont,
      }}
    >
      <CellSpan cells={[{ char: "ashlr " }]} />
      <CellSpan cells={[heart]} />
      <CellSpan cells={[{ char: " · 7d " }]} />
      <CellSpan cells={spark} />
      <CellSpan cells={[{ char: ` · session ` }]} />
      {activity ? <CellSpan cells={[activity]} /> : null}
      <CellSpan cells={[{ char: sessionLabel + " · lifetime " + lifetimeLabel }]} />
    </div>
  );
};

const CellSpan: React.FC<{ cells: readonly Cell[] }> = ({ cells }) => (
  <>
    {cells.map((c, i) => (
      <span
        key={i}
        style={{
          color: c.fg ? `rgb(${c.fg.r}, ${c.fg.g}, ${c.fg.b})` : undefined,
          fontWeight: c.bold ? 700 : 400,
          display: "inline-block",
        }}
      >
        {c.char}
      </span>
    ))}
  </>
);
