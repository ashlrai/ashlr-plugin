"use client";

/**
 * Threads — adapted from reactbits.dev/backgrounds/threads
 * Renders animated sinusoidal thread lines on a canvas at low opacity.
 * Fully respects prefers-reduced-motion (static fallback).
 */
import { useEffect, useRef } from "react";

interface ThreadsProps {
  color?: [number, number, number];
  amplitude?: number;
  distance?: number;
  enableMouseInteraction?: boolean;
  className?: string;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export default function Threads({
  color = [139, 46, 26],
  amplitude = 60,
  distance = 0.2,
  enableMouseInteraction = true,
  className = "",
}: ThreadsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const prefersReduced =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;

    const resize = () => {
      width = canvas.offsetWidth;
      height = canvas.offsetHeight;
      canvas.width = width * devicePixelRatio;
      canvas.height = height * devicePixelRatio;
      ctx.scale(devicePixelRatio, devicePixelRatio);
    };

    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const threadCount = 6;
    const threads = Array.from({ length: threadCount }, (_, i) => ({
      yBase: (height / (threadCount + 1)) * (i + 1),
      phase: (i / threadCount) * Math.PI * 2,
      speed: 0.003 + i * 0.0006,
    }));

    let t = 0;

    const draw = () => {
      ctx.clearRect(0, 0, width, height);

      for (const thread of threads) {
        const yBase = thread.yBase;
        const mx = mouseRef.current.x;
        const my = mouseRef.current.y;

        ctx.beginPath();
        for (let x = 0; x <= width; x += 4) {
          const pct = x / width;
          const wave = Math.sin(pct * Math.PI * 3 + t * thread.speed * 1000 + thread.phase) * amplitude;

          let distort = 0;
          if (enableMouseInteraction) {
            const dx = x - mx;
            const dy = yBase - my;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const influence = Math.max(0, 1 - dist / (width * distance));
            distort = influence * (my - yBase) * 0.4;
          }

          const y = yBase + wave + distort;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }

        const [r, g, b] = color;
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.10)`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (!prefersReduced) {
        t += 0.016;
        rafRef.current = requestAnimationFrame(draw);
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    };

    if (enableMouseInteraction) {
      canvas.addEventListener("mousemove", handleMouseMove);
    }

    if (prefersReduced) {
      draw(); // single static frame
    } else {
      rafRef.current = requestAnimationFrame(draw);
    }

    return () => {
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      canvas.removeEventListener("mousemove", handleMouseMove);
    };
  }, [color, amplitude, distance, enableMouseInteraction]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      style={{ width: "100%", height: "100%", display: "block" }}
    />
  );
}
