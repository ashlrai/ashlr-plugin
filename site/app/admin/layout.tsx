"use client";

// Admin layout — auth gate + sidebar nav.
// Redirects to /dashboard if token missing or user is not admin.

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";

const NAV_ITEMS = [
  { href: "/admin/overview",   label: "Overview" },
  { href: "/admin/users",      label: "Users" },
  { href: "/admin/revenue",    label: "Revenue" },
  { href: "/admin/audit",      label: "Audit Log" },
  { href: "/admin/genome",     label: "Genomes" },
  { href: "/admin/errors",     label: "Errors" },
  { href: "/admin/broadcast",  label: "Broadcast" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter();
  const pathname = usePathname();
  const [checking, setChecking] = useState(true);
  const [token, setToken]       = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("ashlr_token");
    if (!stored) {
      router.replace("/dashboard");
      return;
    }
    // Verify admin status via the overview endpoint
    fetch(`${process.env.NEXT_PUBLIC_ASHLR_API_URL ?? "https://api.ashlr.ai"}/admin/overview`, {
      headers: { Authorization: `Bearer ${stored}` },
      cache: "no-store",
    }).then((res) => {
      if (res.status === 403 || res.status === 401) {
        router.replace("/dashboard");
      } else {
        setToken(stored);
        setChecking(false);
      }
    }).catch(() => {
      router.replace("/dashboard");
    });
  }, [router]);

  if (checking) {
    return (
      <div style={{ background: "var(--paper)", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span className="mono-label">Checking access…</span>
      </div>
    );
  }

  return (
    <div style={{ background: "var(--paper)", minHeight: "100vh", display: "flex" }}>
      {/* Sidebar */}
      <aside style={{
        width: 220,
        borderRight: "1px solid var(--ink-10)",
        padding: "32px 0",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        flexShrink: 0,
      }}>
        <div style={{ padding: "0 24px 24px" }}>
          <span style={{
            fontFamily: "var(--font-fraunces), serif",
            fontSize: 18,
            fontWeight: 600,
            color: "var(--ink)",
          }}>
            ashlr admin
          </span>
        </div>
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              style={{
                display: "block",
                padding: "8px 24px",
                fontFamily: "var(--font-jetbrains), monospace",
                fontSize: 13,
                color: active ? "var(--debit)" : "var(--ink-80)",
                background: active ? "var(--ink-10)" : "transparent",
                textDecoration: "none",
                borderLeft: active ? "2px solid var(--debit)" : "2px solid transparent",
                transition: "all 0.15s",
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </aside>

      {/* Main */}
      <main style={{ flex: 1, padding: "40px 48px", overflow: "auto" }}>
        {/* Pass token via data attribute so child client components can read it */}
        <div data-admin-token={token ?? ""}>
          {children}
        </div>
      </main>
    </div>
  );
}
