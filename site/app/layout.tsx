import product from "@/lib/product.generated.json";
import type { Metadata, Viewport } from "next";
import plugin from "../../package.json";
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
    default: "ashlr · The Token Ledger for Codex and Claude Code",
    template: "%s · ashlr",
  },
  description:
    "Open-source token-efficiency plugin for Codex, Claude Code, and MCP hosts. Per-call savings: reads about −75%, greps about −27% (not end-to-end). MIT-licensed. Opt-in telemetry.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    siteName: "ashlr",
    url: "https://plugin.ashlr.ai/",
    title: "ashlr · The Token Ledger for Codex and Claude Code",
    description:
      "Open-source token-efficiency plugin for Codex, Claude Code, and MCP hosts. Per-call savings: reads about −75%, greps about −27% (not end-to-end). MIT. Opt-in telemetry.",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "ashlr · The Token Ledger: open-source Codex and Claude Code plugin for token savings",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ashlr · The Token Ledger for Codex and Claude Code",
    description:
      "Open-source token-efficiency plugin for Codex, Claude Code, and MCP hosts. Per-call savings: reads about −75%, greps about −27% (not end-to-end). MIT. Opt-in telemetry.",
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
      "@type": ["SoftwareApplication", "SoftwareSourceCode"],
      "@id": "https://plugin.ashlr.ai/#app",
      name: "ashlr",
      alternateName: plugin.name,
      description:
        "Open-source token-efficiency plugin for Codex, Claude Code, and MCP hosts. Per-call savings: reads about −75%, greps about −27% (not end-to-end). MIT-licensed.",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux, Windows",
      url: "https://plugin.ashlr.ai",
      downloadUrl: "https://plugin.ashlr.ai/install.sh",
      softwareVersion: product.version,
      codeRepository: plugin.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""),
      license: `https://opensource.org/licenses/${plugin.license}`,
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
          price: "12",
          priceCurrency: "USD",
          description: "Cloud summarization, cross-machine stats sync, live badge",
        },
        {
          "@type": "Offer",
          name: "Team",
          price: "24",
          priceCurrency: "USD",
          description: "Shared encrypted team genome, org dashboard, audit log",
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
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
        />
        {children}
      </body>
    </html>
  );
}
