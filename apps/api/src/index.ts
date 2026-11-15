import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { runtimeConfig } from "./config.js";
import { WebhookAlertSink, type OperationalAlert, type OperationalAlertSink } from "./lib/operational-alerts.js";
import { InMemoryRateLimitStore, type RateLimitPolicy, type RateLimitStore } from "./modules/admission/index.js";
import { type Authenticator, authenticatorFromEnv, registerAccessControl, SocketTickets, type SocketTicketStore } from "./modules/auth/index.js";
import { identityAdminFromEnv, type IdentityAdmin } from "./modules/auth/identity-admin.js";
import { EvaluationQueue, IndependentGeminiEvaluator, MAX_REPORT_ATTEMPTS, registerReportModule, type Evaluator, type ReportJobStore } from "./modules/report/index.js";
import { startReportRecovery } from "./modules/report/recovery-worker.js";
import { loadEnv } from "./env.js";
import { GeminiClient, geminiApiKeyFromEnv } from "./lib/gemini.js";
import { registerInterviewModule } from "./modules/interview/routes.js";
import { liveMinterFromEnv, type LiveMinter } from "./modules/interview/live.js";
import { loadProblemBank, type BankEntry } from "./modules/interview/problem.js";
import { Professor } from "./modules/interview/review.js";
import {
  GeminiResumeAnalyzer,
  InMemoryPreparationStore,
  registerPreparationModule,
  type PreparationStore,
  type ResumeAnalyzer,
} from "./modules/preparation/index.js";
import { Judge0Runner, PredictedRunner, PreferredRunner } from "./modules/runner/index.js";
import { registerPrivacyModule, type ConsentStore, type DeletionStore } from "./modules/privacy/index.js";
import {
  InMemoryEventLog,
  InMemorySessionStore,
  type EventLog,
  type SessionStore,
  type SessionLifecycle,
} from "./modules/session/index.js";
import { createSupabaseStorage } from "./storage.js";
import { InMemorySupportIncidentStore, registerSupportModule, type SupportIncidentStore } from "./modules/support/index.js";

/**
 * Modular monolith. One process; module boundaries live in code.
 *
 * The interview module owns the routes of a live interview. The event log is
 * built here and shared: the interview module appends to it, the report module
 * reads from it afterwards, and neither knows about the other.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const PROBLEMS_ROOT = join(here, "../../../content/problems");
/** The earlier scenario files. No longer served; kept as fixtures for the evaluator and storage tests. */
export const CONTENT_ROOT = join(here, "../../../content/scenarios");

export interface ServerOptions {
  bank: BankEntry[];
  logger?: boolean;
  production?: boolean;
  authenticator?: Authenticator;
  identityAdmin?: IdentityAdmin;
  webOrigin?: string;
  eventLog?: EventLog;
  sessionStore?: SessionStore;
  socketTickets?: SocketTicketStore;
  reportJobStore?: ReportJobStore;
  evaluator?: Evaluator;
  consentStore?: ConsentStore;
  deletionStore?: DeletionStore;
  supportStore?: SupportIncidentStore;
  sessionRetentionDays?: number;
  lifecycle?: SessionLifecycle;
  preparationStore?: PreparationStore;
  resumeAnalyzer?: ResumeAnalyzer;
  closeStorage?: () => Promise<void>;
  readinessChecks?: ReadonlyArray<{ name: string; check: () => Promise<void> }>;
  writesPermitted?: () => boolean;
  release?: string;
  rateLimiter?: RateLimitStore;
  rateLimits?: RateLimitPolicy;
  status?: () => Record<string, unknown>;
  alertSink?: OperationalAlertSink;
  /** Runs candidate code in a sandbox, or predicts the result when none is up. */
  runner?: PreferredRunner;
  /** Absent when no key is configured: voice then answers 503 and chat still works. */
  liveMinter?: LiveMinter | null;
  reskinClient?: GeminiClient;
  chatClient?: GeminiClient;
  professor?: Professor;
}

export function buildServer(opts: ServerOptions) {
  const app = Fastify({ logger: opts.logger ? {
    redact: ["req.headers.authorization", "req.headers.apikey", "req.headers.cookie"],
    // Tickets are single-use but still credentials: omit URL queries from logs.
    serializers: { req: (req) => ({ method: req.method, url: req.url.split("?")[0] ?? "", id: req.id, hostname: req.hostname, remoteAddress: req.ip, remotePort: req.socket.remotePort ?? 0 }) },
  } : false, bodyLimit: 256_000 });

  let draining = false;
  app.decorate("beginDrain", () => { draining = true; });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Request-Id", req.id);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (opts.production) reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  });
  app.addHook("preHandler", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" &&
        opts.writesPermitted && !opts.writesPermitted()) {
      return reply.code(503).header("Retry-After", "10").send({ error: "API_REPLICA_LEASE_LOST" });
    }
    if (draining && req.method === "POST" && [
      "/v1/interview-sessions", "/v1/preparations",
    ].includes(req.routeOptions.url ?? "")) {
      return reply.code(503).header("Retry-After", "10").send({ error: "SERVICE_DRAINING" });
    }
  });
  if (opts.production) app.setErrorHandler((error, req, reply) => {
    const proposed = typeof error === "object" && error !== null && "statusCode" in error &&
      typeof error.statusCode === "number" ? error.statusCode : 500;
    const status = proposed >= 400 && proposed < 500 ? proposed : 500;
    req.log.error({ requestId: req.id, status, errorType: error instanceof Error ? error.name : typeof error }, "request failed");
    return reply.code(status).send({ error: status === 500 ? "INTERNAL_ERROR" : "REQUEST_REJECTED", requestId: req.id });
  });

  const webOrigin = opts.webOrigin ?? process.env["WEB_ORIGIN"] ?? "http://localhost:3000";
  void app.register(cors, {
    origin: opts.authenticator ? [webOrigin] : [webOrigin, "http://localhost:3000", "http://localhost:3001"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "idempotency-key", "authorization"],
  });

  const eventLog = opts.eventLog ?? new InMemoryEventLog();
  const store = opts.sessionStore ?? new InMemorySessionStore();
  const preparationStore = opts.preparationStore ?? new InMemoryPreparationStore();
  const supportStore = opts.supportStore ?? new InMemorySupportIncidentStore();
  const pendingAlerts = new Set<Promise<void>>();
  const publishAlert = (alert: OperationalAlert) => {
    if (!opts.alertSink) return;
    const work = opts.alertSink.publish(alert)
      .catch(() => app.log.error({ alert: alert.kind }, "operational alert delivery failed"));
    pendingAlerts.add(work);
    void work.finally(() => pendingAlerts.delete(work));
  };
  registerAccessControl(app, { sessions: store, webOrigin, tickets: opts.socketTickets ?? new SocketTickets(), ...(opts.authenticator ? { authenticator: opts.authenticator } : {}) });
  const rateLimiter = opts.rateLimiter ?? new InMemoryRateLimitStore();
  const rateLimits = opts.rateLimits ?? {
    sessionCreatesPerMinute: 5,
    preparationsPerMinute: 5,
    realtimeMintsPerMinute: 6,
    runRequestsPerMinute: 10,
    supportReportsPerMinute: 3,
    voiceLatencyPerMinute: 30,
  };
  app.addHook("preHandler", async (req, reply) => {
    if (req.method !== "POST") return;
    const route = req.routeOptions.url ?? "";
    const limit = route === "/v1/interview-sessions" ? rateLimits.sessionCreatesPerMinute
      : route === "/v1/preparations" ? rateLimits.preparationsPerMinute
        : route === "/v1/interview-sessions/:id/live" ? rateLimits.realtimeMintsPerMinute
          : route === "/v1/interview-sessions/:id/runs" ? rateLimits.runRequestsPerMinute
            : route === "/v1/interview-sessions/:id/support-incidents" ? rateLimits.supportReportsPerMinute
              : undefined;
    if (!limit) return;
    try {
      const identity = req.principal?.userId ?? `ip:${req.ip}`;
      const result = await rateLimiter.take(`${req.method}:${route}:${identity}`, limit, 60_000);
      reply.header("RateLimit-Limit", String(limit));
      if (!result.allowed) {
        return reply.code(429).header("Retry-After", String(result.retryAfterSeconds))
          .send({ error: "RATE_LIMITED", retryAfterSeconds: result.retryAfterSeconds });
      }
    } catch {
      req.log.error({ route }, "rate-limit storage unavailable");
      return reply.code(503).header("Retry-After", "10").send({ error: "ADMISSION_UNAVAILABLE" });
    }
  });
  const evaluationQueue = new EvaluationQueue(
    eventLog,
    opts.evaluator,
    undefined,
    opts.reportJobStore,
    (sessionId) => store.pinnedScenario(sessionId),
    (sessionId, attempts, code) => {
      const details = { sessionId, attempts, code };
      if (attempts >= MAX_REPORT_ATTEMPTS) {
        app.log.error(details, "report evaluation attempts exhausted");
        publishAlert({ kind: "REPORT_EVALUATION_EXHAUSTED", ...details });
      }
      else app.log.warn(details, "report evaluation failed; retry remains");
    },
  );
  let stopRecovery: (() => Promise<void>) | undefined;
  if (opts.reportJobStore) app.addHook("onReady", async () => {
    stopRecovery = startReportRecovery(() => evaluationQueue.recover(), (consecutiveFailures) => {
      if (consecutiveFailures === 1 || consecutiveFailures % 12 === 0) {
        app.log.error({ consecutiveFailures }, "report recovery unavailable; pending work will be retried");
        publishAlert({ kind: "REPORT_RECOVERY_UNAVAILABLE", consecutiveFailures });
      }
    });
  });
  app.addHook("onClose", async () => {
    await stopRecovery?.();
    await evaluationQueue.drain();
    await Promise.allSettled([...pendingAlerts]);
    await opts.closeStorage?.();
  });

  // Decorated on the root instance, not inside the plugins: Fastify
  // encapsulates decorations per plugin scope, so a decorate() call inside
  // registerReportModule would be invisible out here.
  app.decorate("evaluationQueue", evaluationQueue);

  app.get("/health", async () => ({ ok: true, problems: opts.bank.length }));
  app.get("/health/live", async () => ({ status: "live", release: opts.release ?? "development" }));
  app.get("/health/ready", async (_req, reply) => {
    if (draining) return reply.code(503).send({ status: "draining" });
    const checks = opts.readinessChecks ?? [];
    const results = await Promise.allSettled(checks.map((item) => item.check()));
    const failed = results.flatMap((result, index) => result.status === "rejected"
      ? [checks[index]?.name ?? "unknown"] : []);
    if (failed.length) return reply.code(503).send({ status: "unavailable", checks: failed });
    return reply.send({ status: "ready", problems: opts.bank.length, release: opts.release ?? "development" });
  });
  app.get("/health/status", async () => ({
    status: "ok",
    release: opts.release ?? "development",
    ...(opts.status ? { capabilities: opts.status() } : {}),
  }));

  void app.register(registerInterviewModule, {
    prefix: "/v1",
    store,
    eventLog,
    evaluationQueue,
    bank: opts.bank,
    preparations: preparationStore,
    runner: opts.runner ?? new PreferredRunner(null, null),
    liveMinter: opts.liveMinter ?? null,
    ...(opts.lifecycle ? { lifecycle: opts.lifecycle } : {}),
    ...(opts.reskinClient ? { reskinClient: opts.reskinClient } : {}),
    ...(opts.chatClient ? { chatClient: opts.chatClient } : {}),
    ...(opts.professor ? { professor: opts.professor } : {}),
    onCompletionDiscoveryFailure: (consecutiveFailures) =>
      publishAlert({ kind: "SESSION_COMPLETION_UNAVAILABLE", consecutiveFailures }),
  });
  void app.register(registerPreparationModule, {
    prefix: "/v1",
    store: preparationStore,
    ...(opts.resumeAnalyzer ? { analyzer: opts.resumeAnalyzer } : {}),
  });
  void app.register(registerReportModule, { prefix: "/v1", eventLog, queue: evaluationQueue });
  void app.register(registerSupportModule, {
    prefix: "/v1",
    store: supportStore,
    onCreated: (incident) => publishAlert({
      kind: "USER_REPORTED_INCIDENT",
      incidentId: incident.id,
      sessionId: incident.sessionId,
      category: incident.category,
      requestId: incident.requestId,
    }),
  });
  void app.register(registerPrivacyModule, {
    prefix: "/v1",
    eventLog,
    sessions: store,
    evaluationQueue,
    ...(opts.consentStore ? { consentStore: opts.consentStore } : {}),
    ...(opts.deletionStore ? { deletionStore: opts.deletionStore } : {}),
    ...(opts.sessionRetentionDays ? { sessionRetentionDays: opts.sessionRetentionDays } : {}),
    preparationStore,
    supportStore,
    onMaintenanceFailure: (consecutiveFailures) =>
      publishAlert({ kind: "PRIVACY_MAINTENANCE_UNAVAILABLE", consecutiveFailures }),
    ...(opts.identityAdmin ? { identityAdmin: opts.identityAdmin } : {}),
  });

  return app;
}

export async function start(): Promise<void> {
  // Before anything reads process.env. Called here rather than at import time
  // so importing this module from a test does not pull in a personal .env.local.
  const env = loadEnv();
  const config = runtimeConfig(process.env);
  const authenticator = authenticatorFromEnv(process.env);

  // Problems load at boot and fail loudly: a content bug should stop a start,
  // not surface mid-interview.
  const bank = await loadProblemBank(PROBLEMS_ROOT);
  if (bank.length === 0) throw new Error("CONFIGURATION_INVALID: content/problems is empty");

  const apiKey = geminiApiKeyFromEnv();
  const text = (model: string, requestTimeoutMs: number) => new GeminiClient({ apiKey, model, requestTimeoutMs });
  const fastModel = process.env["CHAT_MODEL"] || "gemini-3.5-flash";

  // Real execution when a Judge0 sandbox answers; otherwise a labelled prediction.
  const judge0Url = process.env["JUDGE0_URL"]?.replace(/[/]$/, "");
  const judge0 = judge0Url ? new Judge0Runner(judge0Url) : null;
  const sandbox = judge0 && await judge0.healthy() ? judge0 : null;
  const predicted = apiKey ? new PredictedRunner(text(process.env["JUDGE_MODEL"] || fastModel, 30_000)) : null;
  const runner = new PreferredRunner(sandbox, predicted);

  const reskinClient = apiKey ? text(process.env["RESKIN_MODEL"] || fastModel, 20_000) : undefined;
  const chatClient = apiKey ? text(fastModel, 30_000) : undefined;
  const professor = apiKey ? new Professor(text(process.env["REVIEW_MODEL"] || process.env["EVALUATOR_MODEL"] || fastModel, 60_000)) : undefined;
  const evaluatorModel = process.env["EVALUATOR_MODEL"];
  const evaluator = apiKey && evaluatorModel ? new IndependentGeminiEvaluator(text(evaluatorModel, 45_000)) : undefined;
  const resumeAnalyzer = apiKey ? new GeminiResumeAnalyzer(text(process.env["RESUME_ANALYZER_MODEL"] || fastModel, 15_000)) : undefined;
  const liveMinter = liveMinterFromEnv();
  const alertSink = config.alertWebhookUrl ? new WebhookAlertSink({
    url: config.alertWebhookUrl,
    release: config.release,
    ...(config.alertWebhookToken ? { token: config.alertWebhookToken } : {}),
  }) : undefined;

  // Supabase is PostgreSQL. Its direct/pooler connection string activates the
  // durable repositories; local development may still run explicitly in memory.
  const databaseUrl = config.databaseUrl;
  // In production a database that cannot be reached stops the start. In local
  // development it must not: the interview runs in memory and says so loudly.
  let storageFallback: string | undefined;
  const durableStorage = databaseUrl
    ? await createSupabaseStorage(databaseUrl, undefined, config.admission, config.production).catch((error: unknown) => {
        if (config.production) throw error;
        storageFallback = error instanceof Error ? error.message : "STORAGE_UNAVAILABLE";
        return undefined;
      })
    : undefined;
  const identityAdmin = identityAdminFromEnv(process.env);

  const app = buildServer({
    bank,
    logger: true,
    production: config.production,
    webOrigin: config.webOrigin,
    release: config.release,
    rateLimits: config.rateLimits,
    sessionRetentionDays: config.sessionRetentionDays,
    runner,
    liveMinter,
    status: () => ({
      admission: config.admission.enabled ? "OPEN" : "PAUSED",
      authentication: authenticator ? "AVAILABLE" : "DEVELOPMENT",
      storage: durableStorage ? "AVAILABLE" : "MEMORY",
      voice: liveMinter ? "AVAILABLE" : "UNAVAILABLE",
      chat: chatClient ? "AVAILABLE" : "UNAVAILABLE",
      evaluator: evaluator ? evaluator.operationalStatus().circuit : "FALLBACK",
      runFeedback: sandbox ? "EXECUTED" : predicted ? "PREDICTED" : "UNAVAILABLE",
      alerts: alertSink ? "WEBHOOK" : "LOG_ONLY",
    }),
    ...(durableStorage ? { readinessChecks: [{ name: "storage", check: durableStorage.storageReadiness }] } : {}),
    ...(authenticator ? { authenticator } : {}),
    ...(identityAdmin ? { identityAdmin } : {}),
    ...(resumeAnalyzer ? { resumeAnalyzer } : {}),
    ...(reskinClient ? { reskinClient } : {}),
    ...(chatClient ? { chatClient } : {}),
    ...(professor ? { professor } : {}),
    ...(evaluator ? { evaluator } : {}),
    ...(alertSink ? { alertSink } : {}),
    ...(durableStorage ?? {}),
  });
  const port = config.port;

  // Names only, never values.
  app.log.info({ files: env.loaded, vars: env.applied }, "environment loaded");

  app.log.info({
    problems: bank.length,
    authentication: authenticator ? "supabase" : "insecure-local-development",
    voice: liveMinter ? liveMinter.model : "none",
    chat: chatClient ? fastModel : "none",
    runs: sandbox ? "judge0 (executed)" : predicted ? "model (predicted)" : "none",
    evaluator: evaluator ? `${evaluatorModel}:independent-v1` : "deterministic-baseline",
  }, "interview service ready");
  if (storageFallback) {
    app.log.warn(`Database not usable (${storageFallback}): running IN MEMORY. Interviews and reports are lost when this process stops.`);
  }
  if (!liveMinter) app.log.warn("No REALTIME_API_KEY or GEMINI_API_KEY: voice interviews are DISABLED.");
  if (!sandbox && predicted) {
    app.log.warn("No Judge0 sandbox reachable: test results are PREDICTED by a model, not executed, and are labelled so.");
  }
  await app.listen({ port, host: "0.0.0.0" });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.beginDrain();
    app.log.info({ signal, drainGraceMs: config.drainGraceMs }, "shutdown started");
    try {
      await new Promise((resolve) => setTimeout(resolve, config.drainGraceMs));
      await app.close();
      app.log.info({ signal }, "shutdown complete");
    } catch {
      process.exitCode = 1;
      app.log.error({ signal }, "shutdown failed");
    }
  };
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.once("SIGINT", () => { void shutdown("SIGINT"); });
}

const entry = (process.argv[1] ?? "").replace(/\\/g, "/");
if (entry.endsWith("src/index.ts") || entry.endsWith("dist/index.js")) {
  start().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "STARTUP_FAILED";
    const safe = message.startsWith("CONFIGURATION_INVALID:") ||
      ["STORAGE_SCHEMA_INCOMPLETE", "STORAGE_UNAVAILABLE", "AUTH_CONFIGURATION"].includes(message)
      ? message : "STARTUP_FAILED";
    console.error(safe);
    process.exit(1);
  });
}

declare module "fastify" {
  interface FastifyInstance { beginDrain(): void }
}
