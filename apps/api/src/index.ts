import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import { loadEnv } from "./env.js";
import { EvaluationQueue, registerReportModule } from "./modules/report/index.js";
import { Judge0Runner, type CodeRunner } from "./modules/runner/index.js";
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
  /** Absent until a Judge0 instance exists. Runs then return 503, and say so. */
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
  // so that importing this module from a test does not pull in a developer's
  // personal .env.local.
  const env = loadEnv();

  // Scenarios load at boot and fail loudly. A content bug should stop a deploy,
  // not surface mid-interview as an interviewer that cannot answer questions.
  const library = await loadScenarioLibrary(CONTENT_ROOT);

  // Judge0 is optional at boot. Without it the interview runs, minus execution
  // — which is far better than refusing to start (M2-4 / M0-2).
  const judge0Url = process.env["JUDGE0_URL"];
  const runner: CodeRunner | undefined = judge0Url
    ? new Judge0Runner({
        baseUrl: judge0Url,
        ...(process.env["JUDGE0_AUTH_TOKEN"] ? { authToken: process.env["JUDGE0_AUTH_TOKEN"] } : {}),
      })
    : undefined;

  const app = buildServer({ library, logger: true, ...(runner ? { runner } : {}) });
  const port = Number(process.env["API_PORT"] ?? 4000);

  // Names only, never values.
  app.log.info({ files: env.loaded, vars: env.applied }, "environment loaded");

  app.log.info(
    { scenarios: [...library.keys()], runner: runner ? "judge0" : "none" },
    "scenario library loaded",
  );

  // Loud, because the failure it describes is silent otherwise: the interview
  // runs fine right up until the candidate presses Run and gets a 503.
  if (!runner) {
    app.log.warn(
      "JUDGE0_URL is not set — code execution is DISABLED and run requests will return 503. " +
        "Set it in apps/api/.env.local (see scripts/judge0-setup.sh).",
    );
  }
  await app.listen({ port, host: "0.0.0.0" });
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("src/index.ts") || entry.endsWith("dist/index.js")) {
  start().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}

// Extension is required — this package is ESM with NodeNext resolution, so a
// bare './eval' does not resolve. See the note in YOUR-TASKS.md about whether
// the server entrypoint should re-export the eval harness at all.
export * from "./eval/index.js";