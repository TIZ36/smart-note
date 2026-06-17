import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Bundle minimal node_modules into .next/standalone for a slim
  // production Docker image (no need to pip-install at runtime).
  output: "standalone",
};

export default config;
