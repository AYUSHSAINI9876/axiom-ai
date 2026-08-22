import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle (.next/standalone) containing only the
  // node_modules actually reachable at runtime. The production Docker image
  // copies that instead of the full dependency tree.
  output: "standalone",

  // Type errors fail the build rather than shipping. (Next.js 16 dropped the
  // `eslint` config key; linting runs as its own CI step via `npm run lint`.)
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
