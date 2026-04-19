import { interpolate, useCurrentFrame } from "remotion";
import { fontMono, fontSerif, paper, debit, inkSoft, inkMid } from "../theme";

interface CountUpTileProps {
  label: string;
  target: number;
  /** Frame at which the tile should start counting up. */
  startFrame?: number;
  /** Duration (in frames) over which the number counts to `target`. */
  durationFrames?: number;
  /** Override the large number's format. */
  format?: (n: number) => string;
  /** Show a small delta subtitle under the number, e.g. "+412K today". */
  delta?: string;
}

/**
 * A ledger-card CountUp tile for the /ashlr-dashboard beat. Animates the
 * number from 0 to `target` over `durationFrames` with ease-out-cubic.
 */
export const CountUpTile: React.FC<CountUpTileProps> = ({
  label,
  target,
  startFrame = 0,
  durationFrames = 90,
  format = defaultFormat,
  delta,
}) => {
  const frame = useCurrentFrame();
  const t = interpolate(
    frame,
    [startFrame, startFrame + durationFrames],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOutCubic },
  );
  const value = Math.floor(target * t);

  return (
    <div
      style={{
        background: paper,
        border: `1px solid ${inkSoft}`,
        boxShadow: "4px 4px 0 rgba(18,18,18,0.9)",
        borderRadius: 6,
        padding: "22px 28px",
        minWidth: 240,
        fontFamily: fontMono,
      }}
    >
      <div
        style={{
          fontSize: 14,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: inkMid,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: fontSerif,
          fontSize: 72,
          fontWeight: 700,
          color: debit,
          marginTop: 6,
          lineHeight: 1,
          letterSpacing: "-0.02em",
        }}
      >
        {format(value)}
      </div>
      {delta && (
        <div style={{ fontSize: 13, color: inkMid, marginTop: 8 }}>{delta}</div>
      )}
    </div>
  );
};

function defaultFormat(n: number): string {
  return n.toLocaleString("en-US");
}

function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}
