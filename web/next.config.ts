import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: true,
  poweredByHeader: false,
  reactStrictMode: true,
  // keep the dev-only badge off the sidebar's Collapse button
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
