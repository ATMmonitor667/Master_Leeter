import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import { EvaluationQueue, registerReportModule } from "./modules/report/index.js";
import { loadEnv } from "./env.js";
import { ModelJudgeRunner, type CodeRunner } from "./modules/runner/index.js";
import { registerPrivacyModule } from "./modules/privacy/index.js";
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
}

export function buildServer(opts: ServerOptions) {
  const app = Fastify({ logger: opts.logger ?? false });

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
  const judgeKey = process.env["REALTIME_API_KEY"];
  const runner: CodeRunner | undefined =
    judgeModel && judgeKey
      ? new ModelJudgeRunner({ model: judgeModel, apiKey: judgeKey })
      : undefined;

  const app = buildServer({ library, logger: true, ...(runner ? { runner } : {}) });
  const port = Number(process.env["API_PORT"] ?? 4000);

  // Names only, never values.
  app.log.info({ files: env.loaded, vars: env.applied }, "environment loaded");

  app.log.info(
    { scenarios: [...library.keys()], runner: runner ? "model-judge" : "none" },
    "scenario library loaded",
  );

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
