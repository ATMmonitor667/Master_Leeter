import { z } from "zod";
import type { RateLimitPolicy, SessionAdmissionPolicy } from "./modules/admission/index.js";

const Port = z.coerce.number().int().min(1).max(65_535);
const Duration = z.coerce.number().int().min(0).max(20_000);
const PositiveLimit = z.coerce.number().int().min(1).max(100_000);

export interface RuntimeConfig {
  nodeEnv: "development" | "test" | "production";
  production: boolean;
  port: number;
  webOrigin: string;
  databaseUrl?: string;
  drainGraceMs: number;
  release: string;
  admission: SessionAdmissionPolicy;
  rateLimits: RateLimitPolicy;
}

function validOrigin(value: string | undefined, protocols: readonly string[]): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return protocols.includes(parsed.protocol) && !parsed.username && !parsed.password &&
      !parsed.search && !parsed.hash && parsed.pathname === "/";
  } catch { return false; }
}

function validDatabaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ["postgres:", "postgresql:"].includes(parsed.protocol) && Boolean(parsed.hostname) && parsed.pathname.length > 1;
  } catch { return false; }
}

/**
 * Validate deploy-time configuration without ever echoing a secret value.
 *
 * Feature constructors still own provider-specific validation. This is the
 * admission boundary: production cannot quietly fall back to memory, local
 * origins, file questions, unauthenticated users, or missing voice/grading.
 */
export function runtimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const nodeResult = z.enum(["development", "test", "production"])
    .safeParse(env["NODE_ENV"] ?? "development");
  const nodeEnv = nodeResult.success ? nodeResult.data : "development";
  const production = nodeEnv === "production";
  const invalid = new Set<string>();
  if (!nodeResult.success) invalid.add("NODE_ENV");

  const portResult = Port.safeParse(env["PORT"]?.trim() || env["API_PORT"]?.trim() || "4000");
  if (!portResult.success) invalid.add("PORT");
  const drainResult = Duration.safeParse(env["DRAIN_GRACE_MS"] ?? "5000");
  if (!drainResult.success) invalid.add("DRAIN_GRACE_MS");

  const webOrigin = env["WEB_ORIGIN"]?.trim() || "http://localhost:3000";
  if (!validOrigin(webOrigin, production ? ["https:"] : ["http:", "https:"])) invalid.add("WEB_ORIGIN");

  const databaseUrl = env["DATABASE_URL"]?.trim() || undefined;
  if (databaseUrl && !validDatabaseUrl(databaseUrl)) invalid.add("DATABASE_URL");

  const limit = (name: string, fallback: string) => {
    const parsed = PositiveLimit.safeParse(env[name]?.trim() || fallback);
    if (!parsed.success) invalid.add(name);
    return parsed.success ? parsed.data : Number(fallback);
  };
  const admissionEnabled = env["ADMISSION_ENABLED"]?.trim() || "true";
  if (admissionEnabled !== "true" && admissionEnabled !== "false") invalid.add("ADMISSION_ENABLED");
  const admission: SessionAdmissionPolicy = {
    enabled: admissionEnabled === "true",
    maxActiveInterviews: limit("MAX_ACTIVE_INTERVIEWS", "10"),
    monthlyInterviewsPerUser: limit("MONTHLY_INTERVIEWS_PER_USER", "10"),
    maxRealtimeMintsPerSession: limit("MAX_REALTIME_MINTS_PER_SESSION", "12"),
  };
  const rateLimits: RateLimitPolicy = {
    sessionCreatesPerMinute: limit("SESSION_CREATES_PER_MINUTE", "5"),
    preparationsPerMinute: limit("PREPARATIONS_PER_MINUTE", "5"),
    realtimeMintsPerMinute: limit("REALTIME_MINTS_PER_MINUTE", "6"),
    runRequestsPerMinute: limit("RUN_REQUESTS_PER_MINUTE", "10"),
  };

  if (production) {
    const required = [
      "DATABASE_URL",
      "SUPABASE_URL",
      "SUPABASE_PUBLISHABLE_KEY",
      "REALTIME_API_KEY",
      "REALTIME_MODEL",
      "CLASSIFIER_MODEL",
      "EVALUATOR_MODEL",
      "ADMISSION_ENABLED",
      "MAX_ACTIVE_INTERVIEWS",
      "MONTHLY_INTERVIEWS_PER_USER",
      "MAX_REALTIME_MINTS_PER_SESSION",
      "SESSION_CREATES_PER_MINUTE",
      "PREPARATIONS_PER_MINUTE",
      "REALTIME_MINTS_PER_MINUTE",
      "RUN_REQUESTS_PER_MINUTE",
    ] as const;
    for (const name of required) if (!env[name]?.trim()) invalid.add(name);
    if (!(env["SUPABASE_SECRET_KEY"] || env["SUPABASE_SERVICE_ROLE_KEY"])?.trim()) {
      invalid.add("SUPABASE_SECRET_KEY");
    }
    if (env["AUTH_MODE"] !== "supabase") invalid.add("AUTH_MODE");
    if (env["QUESTION_BANK_SOURCE"] !== "supabase") invalid.add("QUESTION_BANK_SOURCE");
    if (env["ALLOW_INSECURE_DEV"] === "1") invalid.add("ALLOW_INSECURE_DEV");
    if (!validOrigin(env["SUPABASE_URL"], ["https:"])) invalid.add("SUPABASE_URL");
    if (!env["GEMINI_API_KEY"]?.trim() && !env["REALTIME_API_KEY"]?.trim()) invalid.add("GEMINI_API_KEY");
  }

  if (invalid.size) throw new Error(`CONFIGURATION_INVALID:${[...invalid].sort().join(",")}`);
  return {
    nodeEnv,
    production,
    port: portResult.success ? portResult.data : 4000,
    webOrigin,
    ...(databaseUrl ? { databaseUrl } : {}),
    drainGraceMs: drainResult.success ? drainResult.data : 5_000,
    release: env["RELEASE_SHA"]?.trim().slice(0, 64) || "development",
    admission,
    rateLimits,
  };
}
