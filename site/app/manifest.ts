import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ashlr · The Token Ledger for Codex and Claude Code",
    short_name: "ashlr",
    description:
      "Open-source Codex, Claude Code, and MCP host plugin. Mean −57% cross-repo token savings. MIT-licensed.",
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
