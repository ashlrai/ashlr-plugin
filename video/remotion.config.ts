import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setPixelFormat("yuv420p");
Config.setCodec("h264");
Config.setConcurrency(4);
Config.setEntryPoint("src/index.ts");
Config.setOverwriteOutput(true);
