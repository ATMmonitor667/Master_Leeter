import Fastify from "fastify";
import { registerReportModule } from "./modules/report/index.js";
import { registerScenarioModule } from "./modules/scenario/index.js";
import { registerSessionModule } from "./modules/session/index.js";

/**
 * Modular monolith (ADR-005).
 *
 * One process, four modules with boundaries enforced in code so services can be
 * extracted later without a rewrite. The orchestrator is deliberately NOT an
 * HTTP module — it is a domain layer the session module calls into. Interview
 * policy must never live in a transport handler.
 */
export function buildServer() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ ok: true }));

  void app.register(registerSessionModule, { prefix: "/v1" });
  void app.register(registerScenarioModule, { prefix: "/v1" });
  void app.register(registerReportModule, { prefix: "/v1" });

  return app;
}

const isEntrypoint = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");

if (isEntrypoint) {
  const app = buildServer();
  const port = Number(process.env["API_PORT"] ?? 4000);
  app.listen({ port, host: "0.0.0.0" }).catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
}
