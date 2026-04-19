import { AbsoluteFill } from "remotion";
import { HeroVideo } from "./HeroVideo";
import { paper } from "../theme";

/**
 * 9:16 vertical crop of the hero video for TikTok / Shorts / LinkedIn Reels.
 * Uses the same composition scaled/letterboxed into a 1080×1920 frame.
 * A full re-layout pass will come in Task #15; for now this is a
 * letterbox-style embed that still plays cleanly.
 */
export const HeroVideoVertical: React.FC = () => (
  <AbsoluteFill style={{ background: paper }}>
    <AbsoluteFill
      style={{
        transform: "scale(0.5625)",
        transformOrigin: "center center",
        top: "50%",
        left: "50%",
        translate: "-50% -50%",
        width: 1920,
        height: 1080,
      }}
    >
      <HeroVideo />
    </AbsoluteFill>
  </AbsoluteFill>
);
