import { InterviewStateSchema } from "@master-leeter/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userIdFor } from "../auth/index.js";
import {
  InMemorySupportIncidentStore,
  SUPPORT_CATEGORIES,
  type SupportIncidentStore,
} from "./store.js";

export { InMemorySupportIncidentStore, SUPPORT_CATEGORIES, type SupportIncidentStore } from "./store.js";
export { PgSupportIncidentStore } from "./pg-store.js";

const Body = z.object({
  reportId: z.string().uuid(),
  category: z.enum(SUPPORT_CATEGORIES),
  consentDiagnostics: z.literal(true),
  diagnostics: z.object({
    connected: z.boolean(),
    online: z.boolean(),
    visibility: z.enum(["visible", "hidden"]),
    pendingSaves: z.number().int().min(0).max(10_000),
    stage: InterviewStateSchema,
    voiceStatus: z.enum(["IDLE", "CONNECTING", "LISTENING", "SPEAKING", "FAILED"]),
  }).strict(),
}).strict();

const RETENTION_DAYS = 30;

export async function registerSupportModule(app: FastifyInstance, opts: {
  store?: SupportIncidentStore;
  onCreated?: (incident: { id: string; sessionId: string; category: typeof SUPPORT_CATEGORIES[number]; requestId: string }) => void;
}): Promise<void> {
  const store = opts.store ?? new InMemorySupportIncidentStore();
  let maintenance: Promise<void> | undefined;
  const maintain = () => maintenance ??= store.purgeExpired(new Date().toISOString())
    .then(() => undefined)
    .finally(() => { maintenance = undefined; });
  const timer = setInterval(() => { void maintain(); }, 60 * 60_000);
  timer.unref();
  app.addHook("onReady", maintain);
  app.addHook("onClose", async () => { clearInterval(timer); await maintenance; });

  app.post("/interview-sessions/:id/support-incidents", async (req, reply) => {
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_SUPPORT_REPORT" });
    const { id: sessionId } = req.params as { id: string };
    const createdAt = new Date().toISOString();
    try {
      const saved = await store.create({
        idempotencyKey: body.data.reportId,
        userId: userIdFor(req),
        sessionId,
        category: body.data.category,
        diagnostics: body.data.diagnostics,
        requestId: req.id,
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + RETENTION_DAYS * 86_400_000).toISOString(),
      });
      opts.onCreated?.({ id: saved.id, sessionId, category: saved.category, requestId: saved.requestId });
      return reply.code(201).send({
        incidentId: saved.id,
        requestId: saved.requestId,
        createdAt: saved.createdAt,
        retentionDays: RETENTION_DAYS,
      });
    } catch {
      req.log.error({ sessionId, category: body.data.category }, "support incident storage unavailable");
      return reply.code(503).send({ error: "SUPPORT_REPORT_UNAVAILABLE", requestId: req.id });
    }
  });
}
