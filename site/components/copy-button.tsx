"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

interface CopyButtonProps {
  text: string;
  className?: string;
}

export default function CopyButton({ text, className = "" }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback for older browsers
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "absolute";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.14em] uppercase
        px-2.5 py-1.5 border border-[var(--ink-30)] text-[var(--ink-55)]
        hover:border-[var(--ink)] hover:text-[var(--ink)]
        transition-all duration-200 cursor-pointer bg-transparent ${className}`}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
    >
      {copied ? (
        <>
          <Check size={11} strokeWidth={2} />
          <span>Copied</span>
        </>
      ) : (
        <>
          <Copy size={11} strokeWidth={2} />
          <span>Copy</span>
        </>
      )}
    </button>
  );
}
