import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ["react-bits", "framer-motion", "lucide-react"],
  },
};

export default nextConfig;
