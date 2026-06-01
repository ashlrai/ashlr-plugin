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
    "Open-source Claude Code plugin. Mean −79.5% token savings on files ≥ 2 KB (small files cached free). MIT-licensed. Opt-in telemetry. Works with Claude Code, Cursor, and Windsurf.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    siteName: "ashlr",
    url: "https://plugin.ashlr.ai/",
    title: "ashlr · The Token Ledger for Claude Code",
    description:
      "Open-source Claude Code plugin. Mean −79.5% token savings on files 2 KB and larger. MIT. Opt-in telemetry.",
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
      "Open-source Claude Code plugin. Mean −79.5% token savings on files 2 KB and larger. MIT. Opt-in telemetry.",
    images: ["/opengraph-image"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F3EADB",
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://plugin.ashlr.ai/#organization",
      name: "ashlr",
      url: "https://plugin.ashlr.ai",
      sameAs: [
        "https://github.com/ashlrai/ashlr-plugin",
      ],
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://plugin.ashlr.ai/#app",
      name: "ashlr",
      alternateName: "ashlr-plugin",
      description:
        "Open-source Claude Code plugin. Mean −79.5% token savings on files ≥ 2 KB. MIT-licensed.",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux, Windows",
      url: "https://plugin.ashlr.ai",
      downloadUrl: "https://plugin.ashlr.ai/install.sh",
      softwareVersion: "latest",
      license: "https://opensource.org/licenses/MIT",
      publisher: {
        "@id": "https://plugin.ashlr.ai/#organization",
      },
      offers: [
        {
          "@type": "Offer",
          name: "Free",
          price: "0",
          priceCurrency: "USD",
          description: "Full plugin, community support, opt-in telemetry",
        },
        {
          "@type": "Offer",
          name: "Pro",
          price: "15",
          priceCurrency: "USD",
          description: "Cloud genome, Pro dashboard, priority support",
        },
        {
          "@type": "Offer",
          name: "Team",
          price: "49",
          priceCurrency: "USD",
          description: "Shared team genome, audit logs, SSO",
        },
      ],
    },
  ],
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
      <body>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {children}
      </body>
    </html>
  );
}
