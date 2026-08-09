import type { FastifyInstance } from "fastify";

/**
 * Report module — post-session evaluation.
 *
 * A queue consumer over the immutable event log. It cannot block, touch, or read
 * into the live session path (ADR-004). Mixing the live interviewer and the
 * evaluator causes leakage and self-grading bias.
 *
 * Every score cites evidence. Reports evaluate observable interview behavior
 * only — no personality, medical, psychological, or protected-class inference.
 *
 * Issues: M6-1 rubric · M6-2 evaluator · M6-3 report UI · M6-4 endpoint · M6-5 calibration
 */
export async function registerReportModule(app: FastifyInstance): Promise<void> {
  app.get("/interview-sessions/:id/report", async (_req, reply) => {
    // M6-4: returns in-progress | ready | failed-and-retryable.
    // Regenerable from events after a rubric change.
    return reply.code(501).send({ error: "NOT_IMPLEMENTED", issue: "M6-4" });
  });
}
