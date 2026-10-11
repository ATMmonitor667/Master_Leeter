import { describe, expect, it } from "vitest";
import { runtimeConfig } from "./config.js";

function production(): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", AUTH_MODE: "supabase", QUESTION_BANK_SOURCE: "supabase",
    WEB_ORIGIN: "https://web.example", DATABASE_URL: "postgresql://runtime:test-only@db.example/postgres",
    SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-only",
    SUPABASE_SECRET_KEY: "secret-test-only", REALTIME_API_KEY: "provider-test-only", REALTIME_MODEL: "live-fixture",
    CLASSIFIER_MODEL: "classifier-fixture", EVALUATOR_MODEL: "grader-fixture", ADMISSION_ENABLED: "true",
    MAX_ACTIVE_INTERVIEWS: "10", MONTHLY_INTERVIEWS_PER_USER: "10", MAX_REALTIME_MINTS_PER_SESSION: "12",
    SESSION_CREATES_PER_MINUTE: "5", PREPARATIONS_PER_MINUTE: "5", REALTIME_MINTS_PER_MINUTE: "6",
    RUN_REQUESTS_PER_MINUTE: "10", SUPPORT_REPORTS_PER_MINUTE: "3", SESSION_RETENTION_DAYS: "365" };
}

describe("production configuration boundary", () => {
  it("accepts the secure release configuration and host port override", () => {
    const config = runtimeConfig({ ...production(), PORT: "4100", API_PORT: "4000" });
    expect(config.production).toBe(true);
    expect(config.port).toBe(4100);
    expect(config.admission.maxActiveInterviews).toBe(10);
  });

  it.each(["DATABASE_URL", "REALTIME_API_KEY", "CLASSIFIER_MODEL", "EVALUATOR_MODEL", "SUPABASE_SECRET_KEY",
    "SESSION_RETENTION_DAYS", "MAX_ACTIVE_INTERVIEWS"])("rejects missing %s", (name) => {
    const env = production(); delete env[name];
    expect(() => runtimeConfig(env)).toThrow(name);
  });

  it.each([
    ["AUTH_MODE", "development"], ["QUESTION_BANK_SOURCE", "files"], ["ALLOW_INSECURE_DEV", "1"],
    ["WEB_ORIGIN", "http://localhost:3000"], ["WEB_ORIGIN", "https://web.example/path"],
    ["MAX_ACTIVE_INTERVIEWS", "0"], ["DRAIN_GRACE_MS", "20001"], ["ADMISSION_ENABLED", "maybe"],
  ])("refuses unsafe %s=%s", (name, value) => {
    expect(() => runtimeConfig({ ...production(), [name]: value })).toThrow(name);
  });

  it("names invalid settings without printing credentials", () => {
    try { runtimeConfig({ ...production(), DATABASE_URL: "sensitive-invalid-database-secret" }); }
    catch (error) {
      expect((error as Error).message).toBe("CONFIGURATION_INVALID:DATABASE_URL");
      return;
    }
    throw new Error("Expected invalid configuration to fail");
  });
});
