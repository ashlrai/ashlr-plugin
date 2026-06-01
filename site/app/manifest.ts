import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ashlr · The Token Ledger for Claude Code",
    short_name: "ashlr",
    description:
      "Open-source Claude Code plugin. Mean −79.5% token savings on files ≥ 2 KB. MIT-licensed.",
    start_url: "/",
    display: "standalone",
    background_color: "#F3EADB",
    theme_color: "#F3EADB",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
