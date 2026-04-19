"use client";

import { useEffect, useState } from "react";

interface Count {
  stars: number;
  downloads: number;
}

/**
 * Live install-count badge. Pulls from /api/install-count (which is cached
 * for 1 h server-side). Renders nothing until the fetch resolves — keeps the
 * initial paint identical to the static MIT/GitHub badge and avoids a CLS
 * shift. If the fetch fails or returns zeros, the badge stays hidden.
 */
export default function InstallCountBadge() {
  const [count, setCount] = useState<Count | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/install-count", { cache: "force-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Count | null) => {
        if (!alive || !data) return;
        if (data.stars === 0 && data.downloads === 0) return;
        setCount(data);
      })
      .catch(() => {
        /* swallow — badge just stays hidden */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!count) return null;

  return (
    <div
      style={{
        fontFamily: "var(--font-jetbrains), ui-monospace, SFMono-Regular, monospace",
        fontSize: 12,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "var(--ink-55)",
        display: "inline-flex",
        alignItems: "center",
        gap: 14,
        marginTop: 20,
      }}
      aria-label={`${count.stars} stars and ${count.downloads} downloads on GitHub`}
    >
      <span>
        <strong style={{ color: "var(--ink-80)", fontWeight: 600 }}>
          {count.stars.toLocaleString("en-US")}
        </strong>{" "}
        stars
      </span>
      <span style={{ opacity: 0.55 }}>·</span>
      {count.downloads > 0 && (
        <>
          <span>
            <strong style={{ color: "var(--ink-80)", fontWeight: 600 }}>
              {count.downloads.toLocaleString("en-US")}
            </strong>{" "}
            downloads
          </span>
          <span style={{ opacity: 0.55 }}>·</span>
        </>
      )}
      <span>MIT</span>
    </div>
  );
}
