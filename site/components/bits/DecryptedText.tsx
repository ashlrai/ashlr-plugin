"use client";

/**
 * DecryptedText — copied from reactbits.dev/text-animations/decrypted-text
 * Scrambles characters on mount then resolves to the real text.
 */
import { useEffect, useRef, useState } from "react";

interface DecryptedTextProps {
  text: string;
  speed?: number;
  maxIterations?: number;
  characters?: string;
  className?: string;
  revealDirection?: "start" | "end" | "center";
  animateOn?: "mount" | "hover";
  encryptedClassName?: string;
  parentClassName?: string;
}

export default function DecryptedText({
  text,
  speed = 50,
  maxIterations = 10,
  characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*",
  className = "",
  revealDirection = "start",
  animateOn = "mount",
  encryptedClassName = "",
  parentClassName = "",
}: DecryptedTextProps) {
  const [displayText, setDisplayText] = useState<string[]>(text.split(""));
  const [isHovering, setIsHovering] = useState(false);
  const [hasAnimated, setHasAnimated] = useState(false);
  const iterationRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const revealedRef = useRef<Set<number>>(new Set());

  const getNextIndex = (revealedSet: Set<number>): number => {
    const textLen = text.length;
    let index: number;
    if (revealDirection === "start") {
      index = revealedSet.size;
    } else if (revealDirection === "end") {
      index = textLen - 1 - revealedSet.size;
    } else {
      const middle = Math.floor(textLen / 2);
      const offset = Math.floor(revealedSet.size / 2);
      index =
        revealedSet.size % 2 === 0 ? middle + offset : middle - offset - 1;
    }
    return index < 0 || index >= textLen ? [...Array(textLen).keys()].find((i) => !revealedSet.has(i)) ?? 0 : index;
  };

  const startAnimation = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    iterationRef.current = 0;
    revealedRef.current = new Set();

    intervalRef.current = setInterval(() => {
      iterationRef.current++;
      const revealedSet = revealedRef.current;

      if (iterationRef.current % 2 === 0 && revealedSet.size < text.length) {
        const nextIndex = getNextIndex(revealedSet);
        revealedSet.add(nextIndex);
      }

      if (revealedSet.size >= text.length) {
        setDisplayText(text.split(""));
        if (intervalRef.current) clearInterval(intervalRef.current);
        setHasAnimated(true);
        return;
      }

      setDisplayText(
        text.split("").map((char, i) => {
          if (char === " ") return " ";
          if (revealedSet.has(i)) return char;
          if (iterationRef.current > maxIterations * 2) return char;
          return characters[Math.floor(Math.random() * characters.length)];
        })
      );
    }, speed);
  };

  useEffect(() => {
    if (animateOn === "mount") {
      // Respect prefers-reduced-motion
      if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        setDisplayText(text.split(""));
        setHasAnimated(true);
        return;
      }
      startAnimation();
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (animateOn === "hover") {
      if (isHovering) {
        startAnimation();
      } else if (!hasAnimated) {
        setDisplayText(text.split(""));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHovering]);

  return (
    <span
      className={parentClassName}
      onMouseEnter={() => animateOn === "hover" && setIsHovering(true)}
      onMouseLeave={() => animateOn === "hover" && setIsHovering(false)}
      aria-label={text}
    >
      {displayText.map((char, i) => (
        <span
          key={i}
          className={
            revealedRef.current.has(i) || hasAnimated
              ? className
              : encryptedClassName
          }
          aria-hidden="true"
        >
          {char}
        </span>
      ))}
    </span>
  );
}
