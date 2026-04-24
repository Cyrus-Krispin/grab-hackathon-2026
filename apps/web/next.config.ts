import type { NextConfig } from "next";
import path from "node:path";

// Monorepo: Turbopack resolves deps from the app dir; set root to repo so hoisted `node_modules` is visible.
const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
};

export default nextConfig;
