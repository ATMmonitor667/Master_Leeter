import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@master-leeter/contracts"],
  // This repository is a pnpm workspace. Without an explicit root, Next can
  // mistake an unrelated user-level package-lock for the project root and try
  // to trace the entire home directory during production builds.
  outputFileTracingRoot: path.resolve(here, "../.."),
};

export default nextConfig;
