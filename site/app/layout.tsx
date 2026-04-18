import type { Metadata, Viewport } from "next";
import { Fraunces, IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
  variable: "--font-fraunces",
  display: "swap",
  preload: true,
});

const ibmPlex = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-ibm-plex",
  display: "swap",
  preload: true,
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains",
  display: "swap",
  preload: true,
});

export const metadata: Metadata = {
  metadataBase: new URL("https://plugin.ashlr.ai"),
  title: {
    default: "ashlr · The Token Ledger for Claude Code",
    template: "%s · ashlr",
  },
  description:
    "Open-source Claude Code plugin. Mean −79.5% token savings on files 2 KB and larger. MIT-licensed. Zero telemetry. Works with Claude Code, Cursor, and Windsurf.",
  alternates: {
    canonical: "https://plugin.ashlr.ai",
  },
  openGraph: {
    type: "website",
    siteName: "ashlr",
    url: "https://plugin.ashlr.ai/",
    title: "ashlr · The Token Ledger for Claude Code",
    description:
      "Open-source Claude Code plugin. Mean −79.5% token savings on files 2 KB and larger. MIT. Zero telemetry.",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "ashlr · The Token Ledger — open-source Claude Code plugin for token savings",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ashlr · The Token Ledger for Claude Code",
    description:
      "Open-source Claude Code plugin. Mean −79.5% token savings on files 2 KB and larger. MIT. Zero telemetry.",
    images: ["/opengraph-image"],
  },
  icons: {
    icon: "/assets/logo.svg",
    apple: "/assets/og.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${ibmPlex.variable} ${jetbrains.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
