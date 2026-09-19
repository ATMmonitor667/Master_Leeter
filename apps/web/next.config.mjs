import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const publicAppEnv = process.env.NEXT_PUBLIC_APP_ENV;
const hostedBuild = process.env.VERCEL === "1" ||
  process.env.DEPLOYMENT_ENV === "production" ||
  publicAppEnv === "production" ||
  publicAppEnv === "preview";

function secureEndpoint(name, protocols) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for a hosted build`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} must be a valid URL`); }
  if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.search || parsed.hash || parsed.pathname !== "/" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    throw new Error(`${name} must use a secure public origin`);
  }
  return parsed.origin;
}

let cspConnect = ["'self'", "https://generativelanguage.googleapis.com", "wss://generativelanguage.googleapis.com"];
if (hostedBuild) {
  if (publicAppEnv !== "production" && publicAppEnv !== "preview") {
    throw new Error("NEXT_PUBLIC_APP_ENV must be production or preview for a hosted build");
  }
  if (process.env.NEXT_PUBLIC_AUTH_MODE !== "supabase") {
    throw new Error("NEXT_PUBLIC_AUTH_MODE must be supabase for a hosted build");
  }
  const api = secureEndpoint("NEXT_PUBLIC_API_URL", ["https:"]);
  const supabase = secureEndpoint("NEXT_PUBLIC_SUPABASE_URL", ["https:"]);
  secureEndpoint("NEXT_PUBLIC_SITE_URL", ["https:"]);
  if (!process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.startsWith("sb_secret_")) {
    throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be a public key for a hosted build");
  }
  const ws = process.env.NEXT_PUBLIC_WS_URL
    ? secureEndpoint("NEXT_PUBLIC_WS_URL", ["wss:"])
    : api.replace(/^https:/, "wss:");
  cspConnect = [...cspConnect, api, ws, supabase, supabase.replace(/^https:/, "wss:")];
} else {
  const api = new URL(process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").origin;
  const ws = process.env.NEXT_PUBLIC_WS_URL || api.replace(/^http/, "ws");
  cspConnect = [...cspConnect, api, ws];
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
    const supabase = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
    cspConnect.push(supabase, supabase.replace(/^https:/, "wss:"));
  }
}

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "worker-src 'self' blob:",
  `connect-src ${[...new Set(cspConnect)].join(" ")}`,
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@master-leeter/contracts"],
  // This repository is a pnpm workspace. Without an explicit root, Next can
  // mistake an unrelated user-level package-lock for the project root and try
  // to trace the entire home directory during production builds.
  outputFileTracingRoot: path.resolve(here, "../.."),
  async headers() {
    const security = [
      { key: "Content-Security-Policy", value: contentSecurityPolicy },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
      ...(hostedBuild ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
    ];
    return [
      { source: "/(.*)", headers: security },
      { source: "/interview/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      { source: "/report/:path*", headers: [{ key: "Cache-Control", value: "private, no-store" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      { source: "/history", headers: [{ key: "Cache-Control", value: "private, no-store" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      { source: "/settings", headers: [{ key: "Cache-Control", value: "private, no-store" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      { source: "/login", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
    ];
  },
};

export default nextConfig;
