import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { EvaluationQueue, registerReportModule } from "./modules/report/index.js";
import { loadEnv } from "./env.js";
import { geminiApiKeyFromEnv } from "./lib/gemini.js";
import { classifierFromEnv, type IntentClassifier } from "./modules/orchestrator/index.js";
import { ModelJudgeRunner, type CodeRunner } from "./modules/runner/index.js";
import { registerPrivacyModule } from "./modules/privacy/index.js";
import { minterFromEnv, type RealtimeTokenMinter } from "./modules/realtime/index.js";
import { registerScenarioModule } from "./modules/scenario/index.js";
import { loadScenarioLibrary } from "./modules/scenario/loader.js";
import type { LoadedScenario } from "./modules/scenario/loader.js";
import { InMemoryEventLog, InMemorySessionStore, registerSessionModule } from "./modules/session/index.js";

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
  logger?: boolean;
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
}

export function buildServer(opts: ServerOptions) {
  const app = Fastify({ logger: opts.logger ?? false });

  const webOrigin = process.env["WEB_ORIGIN"] ?? "http://localhost:3000";
  void app.register(cors, {
    origin: [webOrigin, "http://localhost:3000", "http://localhost:3001"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "idempotency-key"],
  });

  const eventLog = new InMemoryEventLog();
  const store = new InMemorySessionStore();
  const evaluationQueue = new EvaluationQueue(eventLog);

  // Decorated on the root instance, not inside the plugins: Fastify
  // encapsulates decorations per plugin scope, so a decorate() call inside
  // registerReportModule would be invisible out here.
  app.decorate("evaluationQueue", evaluationQueue);

  app.get("/health", async () => ({ ok: true, scenarios: opts.library.size }));

  void app.register(registerSessionModule, {
    prefix: "/v1",
    library: opts.library,
    store,
    eventLog,
    evaluationQueue,
    ...(opts.runner ? { runner: opts.runner } : {}),
    ...(opts.classifier ? { classifier: opts.classifier } : {}),
    ...(opts.realtimeTokenMinter ? { realtimeTokenMinter: opts.realtimeTokenMinter } : {}),
  });
  void app.register(registerScenarioModule, { prefix: "/v1", library: opts.library });
  void app.register(registerReportModule, { prefix: "/v1", eventLog, queue: evaluationQueue });
  void app.register(registerPrivacyModule, {
    prefix: "/v1",
    eventLog,
    sessions: store,
    evaluationQueue,
  });

  return app;
}

export async function start(): Promise<void> {
  // Before anything reads process.env. Called here rather than at import time
  // so importing this module from a test does not pull in a personal .env.local.
  const env = loadEnv();

  // Scenarios load at boot and fail loudly. A content bug should stop a deploy,
  // not surface mid-interview as an interviewer that cannot answer questions.
  const library = await loadScenarioLibrary(CONTENT_ROOT);

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

  // Null when voice is unconfigured. Built once and shared: the token route is
  // the only caller, and the credential it mints is per-request regardless.
  const realtimeTokenMinter = minterFromEnv();

  const app = buildServer({
    library,
    logger: true,
    ...(runner ? { runner } : {}),
    classifier,
    ...(realtimeTokenMinter ? { realtimeTokenMinter } : {}),
  });
  const port = Number(process.env["API_PORT"] ?? 4000);

  // Names only, never values.
  app.log.info({ files: env.loaded, vars: env.applied }, "environment loaded");

  app.log.info(
    {
      scenarios: [...library.keys()],
      runner: runner ? "model-judge" : "none",
      classifier: classifier.id,
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
}

const entry = (process.argv[1] ?? "").replace(/\\/g, "/");
if (entry.endsWith("src/index.ts") || entry.endsWith("dist/index.js")) {
  start().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
