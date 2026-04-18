import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";
import path from "node:path";

const withMDX = createMDX();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ["react-bits", "framer-motion", "lucide-react"],
  },

};

// fumadocs-mdx generates .source/ but doesn't register a webpack alias for
// @/.source. Wrap the final config to inject the alias after withMDX runs.
function withSourceAlias(config: NextConfig): NextConfig {
  const upstream = config.webpack;
  return {
    ...config,
    webpack(webpackConfig, options) {
      const base = upstream ? upstream(webpackConfig, options) : webpackConfig;
      base.resolve ??= {};
      base.resolve.alias ??= {};
      const aliases = base.resolve.alias as Record<string, string>;

      // fumadocs-mdx generates .source/ but doesn't register a webpack alias.
      aliases["@/.source"] = path.resolve(__dirname, ".source");

      return base;
    },
  };
}

export default withSourceAlias(withMDX(nextConfig));
