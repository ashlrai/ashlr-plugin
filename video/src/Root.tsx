import { Composition } from "remotion";
import { HeroVideo } from "./compositions/HeroVideo";
import { HeroVideoVertical } from "./compositions/HeroVideoVertical";
import { video, videoVertical } from "./theme";

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="HeroVideo"
        component={HeroVideo}
        durationInFrames={video.durationFrames}
        fps={video.fps}
        width={video.width}
        height={video.height}
      />
      <Composition
        id="HeroVideoVertical"
        component={HeroVideoVertical}
        durationInFrames={videoVertical.durationFrames}
        fps={videoVertical.fps}
        width={videoVertical.width}
        height={videoVertical.height}
      />
    </>
  );
};
