import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { runtimeConfig } from "./config.js";
import { ProviderCircuit } from "./lib/provider-circuit.js";
import { WebhookAlertSink, type OperationalAlert, type OperationalAlertSink } from "./lib/operational-alerts.js";
import { InMemoryRateLimitStore, type RateLimitPolicy, type RateLimitStore } from "./modules/admission/index.js";
import { type Authenticator, authenticatorFromEnv, registerAccessControl, SocketTickets, type SocketTicketStore } from "./modules/auth/index.js";
import { identityAdminFromEnv, type IdentityAdmin } from "./modules/auth/identity-admin.js";
import { EvaluationQueue, IndependentGeminiEvaluator, MAX_REPORT_ATTEMPTS, registerReportModule, type Evaluator, type ReportJobStore } from "./modules/report/index.js";
import { startReportRecovery } from "./modules/report/recovery-worker.js";
import type { RuntimeOwnership } from "./modules/session/runtime-ownership.js";
import { loadEnv } from "./env.js";
import { GeminiClient, geminiApiKeyFromEnv } from "./lib/gemini.js";
import { classifierFromEnv, GeminiClassifier, type IntentClassifier } from "./modules/orchestrator/index.js";
import {
  GeminiResumeAnalyzer,
  GeminiScenarioRestater,
  InMemoryPreparationStore,
  registerPreparationModule,
  type PreparationStore,
  type ResumeAnalyzer,
  type ScenarioRestater,
} from "./modules/preparation/index.js";
import { ModelJudgeRunner, type CodeRunner } from "./modules/runner/index.js";
import { registerPrivacyModule, type ConsentStore, type DeletionStore } from "./modules/privacy/index.js";
import { minterFromEnv, ttsFromEnv, type RealtimeTokenMinter } from "./modules/realtime/index.js";
import { registerScenarioModule } from "./modules/scenario/index.js";
import { loadScenarioLibrary } from "./modules/scenario/loader.js";
import type { LoadedScenario } from "./modules/scenario/loader.js";
import { FileQuestionBank, type QuestionBank, QuestionBankError, questionBankFromEnv, questionBankSource } from "./modules/scenario/question-bank.js";
import {
  InMemoryEventLog,
  InMemorySessionStore,
  registerSessionModule,
  type EventLog,
  type SessionStore,
  type SessionLifecycle,
} from "./modules/session/index.js";
import { createSupabaseStorage } from "./storage.js";
import { InMemorySupportIncidentStore, registerSupportModule, type SupportIncidentStore } from "./modules/support/index.js";

/**
 * Modular monolith (ADR-005).
 *
 * One process, four modules with boundaries enforced in code so services can be
 * extracted later. The orchestrator is deliberately NOT an HTTP module — it is a
 * domain layer the session module calls into. Interview policy must never live
 * in a transport handler.
 *
 * The event log is constructed here and shared: the session module appends to
 * it, the report module reads from it, and neither knows about the other. That
 * one-directional relationship through immutable evidence is ADR-004 in
 * practice.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const CONTENT_ROOT = join(here, "../../../content/scenarios");

export interface ServerOptions {
  library: Map<string, LoadedScenario>;
  questionBank?: QuestionBank;
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
  runtimeOwnership?: RuntimeOwnership;
  preparationStore?: PreparationStore;
  resumeAnalyzer?: ResumeAnalyzer;
  scenarioRestater?: ScenarioRestater;
  closeStorage?: () => Promise<void>;
  readinessChecks?: ReadonlyArray<{ name: string; check: () => Promise<void> }>;
  release?: string;
  rateLimiter?: RateLimitStore;
  rateLimits?: RateLimitPolicy;
  maxRealtimeMintsPerSession?: number;
  realtimeCircuit?: ProviderCircuit;
  status?: () => Record<string, unknown>;
  alertSink?: OperationalAlertSink;
  /** Absent when no judge model is configured. Runs then return 503, and say so. */
  runner?: CodeRunner;
  /**
   * Absent in tests, where the rule stub is the point. `start()` always supplies
   * one — `classifierFromEnv` returns the stub rather than throwing when
   * unconfigured, so this is never a reason not to boot.
   */
  classifier?: IntentClassifier;
  /**
   * Absent when voice is unconfigured. The token route then answers 503 and the
   * rest of the interview is unaffected.
   */
  realtimeTokenMinter?: RealtimeTokenMinter;
  /**
   * TTS renderer for pre-rendering authored utterances (P3).
   *
   * When absent, every authored line is spoken by the realtime model as before.
   * Built by `ttsFromEnv` in `start()` when TTS_PRERENDER is not "off" and a
   * Gemini API key is available.
   */
  ttsRenderer?: import("./modules/realtime/index.js").TtsRenderer;
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
    if (draining && req.method === "POST" && [
      "/v1/interview-sessions", "/v1/preparations", "/v1/preparations/:id/complete",
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
      : route === "/v1/preparations" || route === "/v1/preparations/:id/complete" ? rateLimits.preparationsPerMinute
        : route === "/v1/interview-sessions/:id/realtime-token" ? rateLimits.realtimeMintsPerMinute
          : route === "/v1/interview-sessions/:id/runs" ? rateLimits.runRequestsPerMinute
            : route === "/v1/interview-sessions/:id/support-incidents" ? rateLimits.supportReportsPerMinute
              : route === "/v1/interview-sessions/:id/voice-latency" ? (rateLimits.voiceLatencyPerMinute ?? 30)
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

  app.get("/health", async () => ({ ok: true, scenarios: opts.library.size }));
  app.get("/health/live", async () => ({ status: "live", release: opts.release ?? "development" }));
  app.get("/health/ready", async (_req, reply) => {
    if (draining) return reply.code(503).send({ status: "draining" });
    const checks = opts.readinessChecks ?? [];
    const results = await Promise.allSettled(checks.map((item) => item.check()));
    const failed = results.flatMap((result, index) => result.status === "rejected"
      ? [checks[index]?.name ?? "unknown"] : []);
    if (failed.length) return reply.code(503).send({ status: "unavailable", checks: failed });
    return reply.send({ status: "ready", scenarios: opts.library.size, release: opts.release ?? "development" });
  });
  app.get("/health/status", async () => ({
    status: "ok",
    release: opts.release ?? "development",
    ...(opts.status ? { capabilities: opts.status() } : {}),
  }));

  void app.register(registerSessionModule, {
    prefix: "/v1",
    library: opts.library,
    ...(opts.questionBank ? { questionBank: opts.questionBank } : {}),
    store,
    eventLog,
    evaluationQueue,
    ...(opts.lifecycle ? { lifecycle: opts.lifecycle } : {}),
    ...(opts.runtimeOwnership ? { runtimeOwnership: opts.runtimeOwnership } : {}),
    ...(opts.runner ? { runner: opts.runner } : {}),
    ...(opts.classifier ? { classifier: opts.classifier } : {}),
    ...(opts.realtimeTokenMinter ? { realtimeTokenMinter: opts.realtimeTokenMinter } : {}),
    ...(opts.maxRealtimeMintsPerSession ? { maxRealtimeMintsPerSession: opts.maxRealtimeMintsPerSession } : {}),
    ...(opts.realtimeCircuit ? { realtimeCircuit: opts.realtimeCircuit } : {}),
    ...(opts.ttsRenderer ? { ttsRenderer: opts.ttsRenderer } : {}),
    onRealtimeCircuitOpen: (sessionId, failureKind) =>
      publishAlert({ kind: "REALTIME_CIRCUIT_OPEN", sessionId, failureKind }),
  });
  void app.register(registerScenarioModule, { prefix: "/v1", library: opts.library, ...(opts.questionBank ? { questionBank: opts.questionBank } : {}) });
  void app.register(registerPreparationModule, {
    prefix: "/v1",
    questionBank: opts.questionBank ?? new FileQuestionBank(opts.library),
    sessions: store,
    events: eventLog,
    ...(opts.lifecycle ? { lifecycle: opts.lifecycle } : {}),
    store: preparationStore,
    ...(opts.resumeAnalyzer ? { analyzer: opts.resumeAnalyzer } : {}),
    ...(opts.scenarioRestater ? { restater: opts.scenarioRestater } : {}),
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

  // Scenarios load at boot and fail loudly. A content bug should stop a deploy,
  // not surface mid-interview as an interviewer that cannot answer questions.
  const library = questionBankSource(process.env) === "files"
    ? await loadScenarioLibrary(CONTENT_ROOT)
    : new Map<string, LoadedScenario>();
  const questionBank = questionBankFromEnv(process.env, library);
  const activeQuestions = await questionBank.listActive();
  if (activeQuestions.length === 0) throw new QuestionBankError("INVALID_CONTENT");
  for (const question of activeQuestions) library.set(question.version.id, question);

  // The judge is optional at boot. Without it the interview runs, minus
  // execution — far better than refusing to start (M2-4).
  const judgeModel = process.env["JUDGE_MODEL"];
  // Same resolution as every other model role: GEMINI_API_KEY, falling back to
  // REALTIME_API_KEY, since one AI Studio key serves Live and the text models.
  const judgeKey = geminiApiKeyFromEnv();
  const runner: CodeRunner | undefined =
    judgeModel && judgeKey
      ? new ModelJudgeRunner({ model: judgeModel, apiKey: judgeKey })
      : undefined;

  // Built once and shared by every session (see SessionModuleOptions.classifier).
  // Returns the rule stub when unconfigured rather than throwing — booting
  // without a model key is a supported state.
  const classifier = classifierFromEnv();

  const preparationKey = geminiApiKeyFromEnv();
  const evaluatorModel = process.env["EVALUATOR_MODEL"];
  const evaluator = preparationKey && evaluatorModel ? new IndependentGeminiEvaluator(new GeminiClient({
    apiKey: preparationKey,
    model: evaluatorModel,
    requestTimeoutMs: 45_000,
  })) : undefined;
  const resumeAnalyzer = preparationKey ? new GeminiResumeAnalyzer(new GeminiClient({
    apiKey: preparationKey,
    model: process.env["RESUME_ANALYZER_MODEL"] ?? process.env["OBSERVER_MODEL"] ?? "gemini-3.5-flash",
    requestTimeoutMs: 15_000,
  })) : undefined;
  const scenarioRestater = preparationKey ? new GeminiScenarioRestater(new GeminiClient({
    apiKey: preparationKey,
    model: process.env["RESTATEMENT_MODEL"] ?? process.env["OBSERVER_MODEL"] ?? "gemini-3.5-flash",
    requestTimeoutMs: 15_000,
  })) : undefined;

  // Null when voice is unconfigured. Built once and shared: the token route is
  // the only caller, and the credential it mints is per-request regardless.
  const realtimeTokenMinter = minterFromEnv();
  // P3: null when TTS_PRERENDER=off or no API key. Falls back to the realtime model.
  const ttsRenderer = ttsFromEnv(process.env, geminiApiKeyFromEnv());
  const realtimeCircuit = new ProviderCircuit(3, 60_000);
  const alertSink = config.alertWebhookUrl ? new WebhookAlertSink({
    url: config.alertWebhookUrl,
    release: config.release,
    ...(config.alertWebhookToken ? { token: config.alertWebhookToken } : {}),
  }) : undefined;

  // Supabase is PostgreSQL. Its direct/pooler connection string activates the
  // durable repositories; local development may still run explicitly in memory.
  const databaseUrl = config.databaseUrl;
  const durableStorage = databaseUrl ? await createSupabaseStorage(databaseUrl, undefined, config.admission) : undefined;
  const identityAdmin = identityAdminFromEnv(process.env);

  const app = buildServer({
    library,
    questionBank,
    logger: true,
    production: config.production,
    webOrigin: config.webOrigin,
    release: config.release,
    rateLimits: config.rateLimits,
    sessionRetentionDays: config.sessionRetentionDays,
    maxRealtimeMintsPerSession: config.admission.maxRealtimeMintsPerSession,
    realtimeCircuit,
    status: () => ({
      admission: config.admission.enabled ? "OPEN" : "PAUSED",
      authentication: authenticator ? "AVAILABLE" : "DEVELOPMENT",
      storage: durableStorage ? "AVAILABLE" : "MEMORY",
      voice: realtimeTokenMinter ? realtimeCircuit.state() : "UNAVAILABLE",
      classifier: classifier instanceof GeminiClassifier ? classifier.operationalStatus().circuit : "FALLBACK",
      evaluator: evaluator ? evaluator.operationalStatus().circuit : "FALLBACK",
      runFeedback: runner ? "AVAILABLE_MODEL_ESTIMATE" : "UNAVAILABLE",
      alerts: alertSink ? "WEBHOOK" : "LOG_ONLY",
    }),
    ...(durableStorage ? { readinessChecks: [{ name: "storage", check: durableStorage.storageReadiness }] } : {}),
    ...(authenticator ? { authenticator } : {}),
    ...(identityAdmin ? { identityAdmin } : {}),
    ...(runner ? { runner } : {}),
    classifier,
    ...(realtimeTokenMinter ? { realtimeTokenMinter } : {}),
    ...(ttsRenderer ? { ttsRenderer } : {}),
    ...(resumeAnalyzer ? { resumeAnalyzer } : {}),
    ...(scenarioRestater ? { scenarioRestater } : {}),
    ...(evaluator ? { evaluator } : {}),
    ...(alertSink ? { alertSink } : {}),
    ...(durableStorage ?? {}),
  });
  const port = config.port;

  // Names only, never values.
  app.log.info({ files: env.loaded, vars: env.applied }, "environment loaded");

  app.log.info(
    {
      scenarios: [...library.keys()],
      questionBank: questionBank.kind,
      authentication: authenticator ? "supabase" : "insecure-local-development",
      runner: runner ? "model-judge" : "none",
      classifier: classifier.id,
      evaluator: evaluator ? `${evaluatorModel}:independent-v1` : "deterministic-baseline",
      realtime: realtimeTokenMinter ? realtimeTokenMinter.id : "none",
    },
    "scenario library loaded",
  );

  // Quieter than the other two warnings on purpose: without voice the product
  // is incomplete rather than misleading. Nothing silently degrades — the token
  // route says 503 and the client has to handle it.
  if (!realtimeTokenMinter) {
    app.log.warn(
      "REALTIME_MODEL or REALTIME_API_KEY is not set — voice is DISABLED and " +
        "POST /realtime-token will return 503. Set both in apps/api/.env.local.",
    );
  }

  if (!evaluator) {
    app.log.warn(
      "EVALUATOR_MODEL or a Gemini API key is not set — reports use the deterministic " +
        "baseline and will not include independent 0-100 solution/transcript grades.",
    );
  }

  // Loud for the same reason the runner warning is: the stub degrades quietly.
  // An interviewer on rules answers clarifications and stays silent correctly,
  // but never notices a complexity claim or a hint request phrased any way the
  // keyword list did not anticipate. It looks like a working interview that is
  // merely reticent, which is the hardest failure to spot.
  if (classifier.id.startsWith("stub-")) {
    app.log.warn(
      "CLASSIFIER_MODEL or an API key is not set — intent classification is running on the " +
        "RULE STUB. The interviewer will miss intents the keyword list does not cover. " +
        "Set CLASSIFIER_MODEL in apps/api/.env.local.",
    );
  }

  // Loud, because the failure is otherwise silent: the interview runs fine right
  // up until the candidate presses Run and gets a 503.
  if (!runner) {
    app.log.warn(
      "JUDGE_MODEL or REALTIME_API_KEY is not set — code checking is DISABLED and run " +
        "requests will return 503. Set both in apps/api/.env.local.",
    );
  } else {
    // Said at every boot on purpose. A judged run is a prediction, and a branch
    // that quietly behaves like it executes code is one you will eventually
    // trust by accident.
    app.log.warn(
      "Code is AI-JUDGED, not executed. Run results are predictions and may be wrong. " +
        "Do not read evaluator scores as measurements on this branch.",
    );
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
      ? message : err instanceof QuestionBankError ? `QUESTION_BANK_${err.code}` : "STARTUP_FAILED";
    console.error(safe);
    process.exit(1);
  });
}

declare module "fastify" {
  interface FastifyInstance { beginDrain(): void }
}
