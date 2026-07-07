import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Vercel deployment compatible — no standalone output */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
