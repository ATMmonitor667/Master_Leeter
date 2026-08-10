import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import { registerReportModule } from "./modules/report/index.js";
import { loadScenarioLibrary } from "./modules/scenario/loader.js";
import { registerScenarioModule } from "./modules/scenario/index.js";
import { registerSessionModule } from "./modules/session/index.js";
import type { LoadedScenario } from "./modules/scenario/loader.js";

/**
 * Modular monolith (ADR-005).
 *
 * One process, four modules with boundaries enforced in code so services can be
 * extracted later. The orchestrator is deliberately NOT an HTTP module — it is a
 * domain layer the session module calls into. Interview policy must never live
 * in a transport handler.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const CONTENT_ROOT = join(here, "../../../content/scenarios");

export interface ServerOptions {
  library: Map<string, LoadedScenario>;
  logger?: boolean;
}

export function buildServer(opts: ServerOptions) {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get("/health", async () => ({ ok: true, scenarios: opts.library.size }));

  void app.register(registerSessionModule, { prefix: "/v1", library: opts.library });
  void app.register(registerScenarioModule, { prefix: "/v1", library: opts.library });
  void app.register(registerReportModule, { prefix: "/v1" });

  return app;
}

export async function start(): Promise<void> {
  // Scenarios load at boot and fail loudly. A content bug should stop a deploy,
  // not surface mid-interview as an interviewer that cannot answer questions.
  const library = await loadScenarioLibrary(CONTENT_ROOT);

  const app = buildServer({ library, logger: true });
  const port = Number(process.env["API_PORT"] ?? 4000);

  app.log.info({ scenarios: [...library.keys()] }, "scenario library loaded");
  await app.listen({ port, host: "0.0.0.0" });
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("src/index.ts") || entry.endsWith("dist/index.js")) {
  start().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
