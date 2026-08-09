import type { FastifyInstance } from "fastify";

/**
 * Scenario module — content loading, versioning, and the clarification map.
 *
 * Scenarios are files in `content/scenarios/`, reviewed by pull request (no CMS
 * in the MVP — see docs/MVP.md). Versions are immutable: retire, never edit
 * (CLAUDE.md invariant 4).
 *
 * The clarification tool returns a canonical fact or NOT_ANSWERABLE. There is no
 * code path in which the model supplies a fact the scenario does not contain.
 *
 * Issues: M1-1 loader · M1-4 clarification map · M1-5 probe eligibility · M7-4 scenarios 2-5
 */
export async function registerScenarioModule(app: FastifyInstance): Promise<void> {
  app.get("/scenarios", async (_req, reply) => {
    // Author/admin only (M2-8). Never exposes oral briefs or hidden tests to a
    // candidate-scoped token.
    return reply.code(501).send({ error: "NOT_IMPLEMENTED", issue: "M1-1" });
  });
}
