#!/usr/bin/env bun
/**
 * Render the hero video at 1080p60, the 9:16 vertical cut, the poster, and
 * the OG still. Called by CI and by `bun run render` locally.
 *
 * Exits non-zero if any render fails. Outputs land in video/out/.
 */

import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface RenderTarget {
  label: string;
  args: string[];
}

const targets: RenderTarget[] = [
  {
    label: "hero 1080p60",
    args: ["render", "HeroVideo", "out/hero.mp4", "--codec=h264", "--crf=18", "--concurrency=4"],
  },
  {
    label: "vertical 9:16",
    args: ["render", "HeroVideoVertical", "out/hero-vertical.mp4", "--codec=h264", "--crf=18"],
  },
  {
    label: "poster still",
    args: ["still", "HeroVideo", "out/hero-poster.jpg", "--frame=60", "--image-format=jpeg"],
  },
  {
    label: "og tagline still",
    args: ["still", "HeroVideo", "out/og.jpg", "--frame=1680", "--image-format=jpeg"],
  },
];

async function runRemotion(label: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["remotion", ...args], { cwd: ROOT, stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`remotion ${args.join(" ")} exited ${code}`));
    });
    child.on("error", reject);
  });
}

for (const target of targets) {
  process.stdout.write(`\n→ ${target.label}\n`);
  try {
    await runRemotion(target.label, target.args);
  } catch (err) {
    process.stderr.write(`✗ ${target.label} failed: ${String(err)}\n`);
    process.exit(1);
  }
}

process.stdout.write("\n✓ all renders complete\n");
