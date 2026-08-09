import type { FastifyInstance } from "fastify";

/**
 * Session module — owns session lifecycle, the app WebSocket, and the event log.
 *
 * Stays THIN. Auth, token minting, routing, trace IDs, and event persistence.
 * Interview policy lives in the orchestrator, not here (system design §6.2).
 *
 * Issues: M2-1 lifecycle · M2-2 WebSocket · M2-7 event log · M2-8 auth · M3-1 realtime token
 */
export async function registerSessionModule(app: FastifyInstance): Promise<void> {
  app.post("/interview-sessions", async (_req, reply) => {
    // M2-1: create from scenario version + policy, pin both, return session ID.
    // Must be idempotent on Idempotency-Key.
    return reply.code(501).send({ error: "NOT_IMPLEMENTED", issue: "M2-1" });
  });

  app.post("/interview-sessions/:id/realtime-token", async (_req, reply) => {
    // M3-1: mint a SHORT-LIVED ephemeral credential.
    // The provider API key must never reach the browser.
    return reply.code(501).send({ error: "NOT_IMPLEMENTED", issue: "M3-1" });
  });

  app.post("/interview-sessions/:id/runs", async (_req, reply) => {
    // M2-4: enqueue only. Execution happens in the external sandbox, never here
    // (CLAUDE.md invariant 6). A runaway run must not pin this service.
    return reply.code(501).send({ error: "NOT_IMPLEMENTED", issue: "M2-4" });
  });

  app.post("/interview-sessions/:id/end", async (_req, reply) => {
    // M2-1: idempotent end of the live phase. Enqueues evaluation; never scores inline.
    return reply.code(501).send({ error: "NOT_IMPLEMENTED", issue: "M2-1" });
  });
}
