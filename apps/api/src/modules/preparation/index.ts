import { randomUUID } from "node:crypto";
import { InterviewerToneSchema } from "@master-leeter/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userIdFor } from "../auth/index.js";
import { EmptyResumeAnalyzer, type ResumeAnalyzer } from "./resume-analyzer.js";
import { InMemoryPreparationStore, type PreparationStore } from "./store.js";
import { publicPreparation, type PreparationRecord } from "./types.js";

/**
 * Resume preparation: analyse a pasted resume and let the candidate confirm
 * which extracted facts are true. A session created with a preparationId gets
 * the confirmed facts as an optional warm-up question in the interviewer prompt.
 */

export * from "./types.js";
export * from "./store.js";
export * from "./pg-store.js";
export * from "./resume-analyzer.js";

export const RESUME_NOTICE_VERSION = "resume-processing-v1";
export const INTERVIEW_SECONDS = 2_700;
export const RESUME_RETENTION_MS = 24 * 60 * 60 * 1_000;

const CreateBody = z.object({
  resumeText: z.string().trim().min(1).max(50_000),
  consent: z.literal(true),
  tone: InterviewerToneSchema.default("NORMAL"),
}).strict();

const ConfirmBody = z.object({
  confirmedFactIds: z.array(z.string().uuid()).max(40),
}).strict();

export interface PreparationModuleOptions {
  store?: PreparationStore;
  analyzer?: ResumeAnalyzer;
}

export async function registerPreparationModule(app: FastifyInstance, opts: PreparationModuleOptions): Promise<void> {
  const store = opts.store ?? new InMemoryPreparationStore();
  const analyzer = opts.analyzer ?? new EmptyResumeAnalyzer();
  const analysisWork = new Map<string, Promise<PreparationRecord>>();
  let purgeWork: Promise<void> | undefined;
  const purgeExpired = (): Promise<void> => {
    purgeWork ??= store.purgeExpiredResumes(new Date().toISOString())
      .then(() => undefined)
      .catch(() => app.log.error("expired resume purge failed"))
      .finally(() => { purgeWork = undefined; });
    return purgeWork;
  };
  const retentionTimer = setInterval(() => { void purgeExpired(); }, 60 * 60_000);
  retentionTimer.unref();
  app.addHook("onReady", purgeExpired);
  app.addHook("onClose", async () => {
    clearInterval(retentionTimer);
    await purgeWork;
  });

  async function owned(id: string, userId: string): Promise<PreparationRecord | null> {
    const record = await store.get(id);
    return record?.userId === userId ? record : null;
  }

  async function ensureAnalysis(record: PreparationRecord): Promise<PreparationRecord> {
    if (record.analysis) return record;
    if (!record.resumeText || record.resumeExpiresAt <= new Date().toISOString()) throw new Error("RESUME_DELETED");
    const existing = analysisWork.get(record.id);
    if (existing) return existing;
    const token = randomUUID();
    const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();
    if (!await store.claimAnalysis(record.id, token, staleBefore)) throw new Error("PREPARATION_BUSY");
    const work = analyzer.analyze(record.resumeText)
      .then((analysis) => store.saveAnalysis(record.id, analysis, token))
      .catch(async (error) => { await store.releaseAnalysis(record.id, token); throw error; })
      .finally(() => analysisWork.delete(record.id));
    analysisWork.set(record.id, work);
    return work;
  }

  app.post("/preparations", async (req, reply) => {
    const key = z.string().trim().min(1).max(200).safeParse(req.headers["idempotency-key"]);
    const body = CreateBody.safeParse(req.body);
    if (!key.success || !body.success) return reply.code(400).send({ error: "INVALID_PREPARATION" });
    try {
      const created = await store.create({
        userId: userIdFor(req), idempotencyKey: key.data, resumeText: body.data.resumeText,
        tone: body.data.tone, noticeVersion: RESUME_NOTICE_VERSION,
        resumeExpiresAt: new Date(Date.now() + RESUME_RETENTION_MS).toISOString(),
      });
      let analyzed: PreparationRecord;
      try { analyzed = await ensureAnalysis(created.record); }
      catch (error) {
        if (preparationFailure(error) === "PREPARATION_BUSY") {
          return reply.code(202).header("Cache-Control", "no-store").send(publicPreparation(created.record));
        }
        throw error;
      }
      return reply.code(created.created ? 201 : 200).header("Cache-Control", "no-store").send(publicPreparation(analyzed));
    } catch (error) {
      req.log.error({ err: safePreparationError(error) }, "preparation analysis failed");
      return reply.code(502).send({ error: "PREPARATION_ANALYSIS_FAILED" });
    }
  });

  app.get("/preparations/:id", async (req, reply) => {
    const id = preparationId(req.params);
    if (!id) return reply.code(404).send({ error: "UNKNOWN_PREPARATION" });
    const record = await owned(id, userIdFor(req));
    return record
      ? reply.header("Cache-Control", "no-store").send(publicPreparation(record))
      : reply.code(404).send({ error: "UNKNOWN_PREPARATION" });
  });

  app.patch("/preparations/:id/facts", async (req, reply) => {
    const id = preparationId(req.params);
    const body = ConfirmBody.safeParse(req.body);
    if (!id || !body.success) return reply.code(400).send({ error: "INVALID_FACT_REVIEW" });
    const record = await owned(id, userIdFor(req));
    if (!record) return reply.code(404).send({ error: "UNKNOWN_PREPARATION" });
    if (record.status !== "REVIEW" || !record.analysis) return reply.code(409).send({ error: "PREPARATION_NOT_REVIEWABLE" });
    const known = new Set(record.analysis.facts.map((fact) => fact.id));
    const unique = [...new Set(body.data.confirmedFactIds)];
    if (unique.length !== body.data.confirmedFactIds.length || unique.some((factId) => !known.has(factId))) {
      return reply.code(400).send({ error: "UNKNOWN_RESUME_FACT" });
    }
    const confirmed = await store.confirmFacts(id, unique);
    return reply.header("Cache-Control", "no-store").send(publicPreparation(confirmed));
  });

  app.delete("/preparations/:id/resume", async (req, reply) => {
    const id = preparationId(req.params);
    if (!id || !await owned(id, userIdFor(req))) return reply.code(404).send({ error: "UNKNOWN_PREPARATION" });
    return reply.send(publicPreparation(await store.deleteResume(id)));
  });

  app.delete("/preparations/:id", async (req, reply) => {
    const id = preparationId(req.params);
    if (!id || !await owned(id, userIdFor(req))) return reply.code(404).send({ error: "UNKNOWN_PREPARATION" });
    await store.delete(id);
    return reply.code(204).send();
  });
}

function preparationId(params: unknown): string | null {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(params);
  return parsed.success ? parsed.data.id : null;
}

function preparationFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "PREPARATION_FAILED";
  return ["PREPARATION_STATE_CONFLICT", "PREPARATION_BUSY"].includes(message) ? message : "PREPARATION_FAILED";
}

function safePreparationError(error: unknown): { name: string; message: string } {
  return { name: error instanceof Error ? error.name : "Error", message: preparationFailure(error) };
}
