"use client";

import { ReactNode, useEffect, useRef, useState } from "react";

interface HeroVideoPlayerProps {
  /**
   * Rendered when the user has requested reduced motion, or when the video
   * fails to load / never appears in the viewport. Keeps the hero visually
   * grounded in both cases.
   */
  fallback: ReactNode;
  /** Override the video src (defaults to /hero.mp4). */
  src?: string;
  /** Override the poster image (defaults to /hero-poster.jpg). */
  poster?: string;
}

/**
 * 30-second ashlr hero loop. Autoplays muted on scroll-into-view, pauses when
 * scrolled out so we don't waste CPU on a backgrounded tab. Falls back to the
 * supplied `fallback` element when the user has `prefers-reduced-motion:
 * reduce` set — we never force animation on people who've asked us not to.
 *
 * Video and poster assets are produced by the Remotion workspace at `video/`
 * and served from `site/public/hero.mp4` + `hero-poster.jpg`.
 */
export default function HeroVideoPlayer({
  fallback,
  src = "/hero.mp4",
  poster = "/hero-poster.jpg",
}: HeroVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    if (reduceMotion || failed) return;
    const el = videoRef.current;
    if (!el) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.play().catch(() => {
              // Autoplay can be blocked on some mobile configs. Surface the
              // fallback rather than leaving a stuck poster on-screen.
              setFailed(true);
            });
          } else {
            el.pause();
          }
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduceMotion, failed]);

  if (reduceMotion || failed) {
    return <>{fallback}</>;
  }

  return (
    <video
      ref={videoRef}
      src={src}
      poster={poster}
      muted
      loop
      playsInline
      preload="metadata"
      onError={() => setFailed(true)}
      style={{
        width: "100%",
        height: "auto",
        aspectRatio: "16 / 9",
        display: "block",
        borderRadius: 6,
        boxShadow: "5px 5px 0 var(--ink)",
        border: "1px solid var(--ink)",
      }}
      aria-label="ashlr plugin in action — 30-second hero demo"
    />
  );
}
