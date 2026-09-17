import { createHash, randomUUID } from "node:crypto";
import { InterviewModeSchema, InterviewerToneSchema, type InterviewMode } from "@master-leeter/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userIdFor } from "../auth/index.js";
import type { LoadedScenario } from "../scenario/loader.js";
import { chooseQuestion, type QuestionBank } from "../scenario/question-bank.js";
import type { SessionLifecycle } from "../session/lifecycle.js";
import type { EventLog } from "../session/event-log.js";
import type { CreateSessionRequest, InterviewSession, SessionStore } from "../session/session-store.js";
import { EmptyResumeAnalyzer, type ResumeAnalyzer } from "./resume-analyzer.js";
import { CanonicalScenarioRestater, type ScenarioRestater } from "./restatement.js";
import { InMemoryPreparationStore, type PreparationStore } from "./store.js";
import { publicPreparation, type PreparationRecord } from "./types.js";

export * from "./types.js";
export * from "./store.js";
export * from "./pg-store.js";
export * from "./resume-analyzer.js";
export * from "./restatement.js";

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

const CompleteBody = z.object({
  scenarioRef: z.string().min(1).max(200).optional(),
  mode: InterviewModeSchema.default("MOCK"),
  language: z.string().trim().min(1).max(40).default("python"),
}).strict();

export interface PreparationModuleOptions {
  store?: PreparationStore;
  questionBank: QuestionBank;
  sessions: SessionStore;
  events: EventLog;
  lifecycle?: SessionLifecycle;
  analyzer?: ResumeAnalyzer;
  restater?: ScenarioRestater;
}

export async function registerPreparationModule(app: FastifyInstance, opts: PreparationModuleOptions): Promise<void> {
  const store = opts.store ?? new InMemoryPreparationStore();
  const analyzer = opts.analyzer ?? new EmptyResumeAnalyzer();
  const restater = opts.restater ?? new CanonicalScenarioRestater();
  const analysisWork = new Map<string, Promise<PreparationRecord>>();
  const completionWork = new Map<string, Promise<PreparationRecord>>();
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

  app.post("/preparations/:id/complete", async (req, reply) => {
    const id = preparationId(req.params);
    const body = CompleteBody.safeParse(req.body ?? {});
    if (!id || !body.success) return reply.code(400).send({ error: "INVALID_COMPLETION" });
    const record = await owned(id, userIdFor(req));
    if (!record) return reply.code(404).send({ error: "UNKNOWN_PREPARATION" });
    if (record.status === "READY") return reply.send(publicPreparation(record));
    if (record.status !== "CONFIRMED") return reply.code(409).send({ error: "RESUME_FACTS_NOT_CONFIRMED" });
    const existing = completionWork.get(id);
    if (existing) return reply.send(publicPreparation(await existing));
    const work = completePreparation(record, body.data, opts, store, restater)
      .finally(() => completionWork.delete(id));
    completionWork.set(id, work);
    try {
      return reply.code(201).header("Cache-Control", "no-store").send(publicPreparation(await work));
    } catch (error) {
      const code = preparationFailure(error);
      req.log.error({ preparationId: id, code }, "preparation completion failed");
      return reply.code(code === "NO_ACTIVE_QUESTIONS" ? 503 : 409).send({ error: code });
    }
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

async function completePreparation(
  initial: PreparationRecord,
  body: { scenarioRef?: string | undefined; mode: InterviewMode; language: string },
  opts: PreparationModuleOptions,
  store: PreparationStore,
  restater: ScenarioRestater,
): Promise<PreparationRecord> {
  let record = initial;
  let scenario: LoadedScenario | null;
  if (record.scenarioVersionId) {
    scenario = await opts.questionBank.get(record.scenarioVersionId);
    if (body.scenarioRef) {
      const requested = await opts.questionBank.get(body.scenarioRef);
      if (!requested || requested.version.id !== record.scenarioVersionId) throw new Error("PREPARATION_ALREADY_PINNED");
    }
  } else {
    scenario = body.scenarioRef
      ? await opts.questionBank.get(body.scenarioRef)
      : chooseQuestion(
          await opts.questionBank.listActive(),
          await opts.sessions.scenarioVersionIdsForUser(record.userId),
        );
    if (!scenario || scenario.version.status !== "ACTIVE") throw new Error("NO_ACTIVE_QUESTIONS");
    record = await store.pinScenario(record.id, scenario.version.id, scenario.contentHash);
  }
  if (!scenario || scenario.version.id !== record.scenarioVersionId || scenario.contentHash !== record.scenarioHash) {
    throw new Error("PINNED_QUESTION_UNAVAILABLE");
  }
  if (!record.restatement) {
    const token = randomUUID();
    const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();
    if (!await store.claimRestatement(record.id, token, staleBefore)) throw new Error("PREPARATION_BUSY");
    try {
      const generated = await restater.restate(scenario.version);
      record = await store.saveRestatement(record.id, generated, token);
    } catch (error) {
      await store.releaseRestatement(record.id, token);
      throw error;
    }
  }
  const wording = record.restatement;
  if (!wording) throw new Error("PREPARATION_STATE_CONFLICT");
  const resumeQuestion = resumeDiscussionQuestion(record);
  const preparedScenario = withRestatement(scenario, wording.openingScript, wording.repeatVariants, resumeQuestion);
  const request: CreateSessionRequest = {
    userId: record.userId, scenario: preparedScenario, mode: body.mode, language: body.language,
    interviewerTone: record.tone, expectedSeconds: INTERVIEW_SECONDS,
    idempotencyKey: `preparation:${record.id}`,
  };
  const session = await createSession(request, opts);
  return store.complete(record.id, wording, session.id);
}

async function createSession(request: CreateSessionRequest, opts: PreparationModuleOptions): Promise<InterviewSession> {
  if (opts.lifecycle) return opts.lifecycle.createStarted(request);
  const session = await opts.sessions.create(request);
  await opts.events.append({
    sessionId: session.id, type: "SESSION_STARTED", actor: "SYSTEM",
    scenarioVersionId: session.scenarioVersionId,
    payload: { mode: session.mode, language: session.language, scenarioHash: session.scenarioHash,
      interviewerTone: session.interviewerTone ?? "NORMAL", expectedSeconds: session.expectedSeconds, preparation: true },
    traceId: session.traceId, idempotencyKey: `session-started:${session.id}`,
  });
  return session;
}

function withRestatement(
  scenario: LoadedScenario,
  openingScript: string,
  repeatVariants: string[],
  resumeQuestion: string | null,
): LoadedScenario {
  const preparedOpening = resumeQuestion ? `${openingScript}\n\n${resumeQuestion}` : openingScript;
  const version = { ...scenario.version, oralBrief: { openingScript: preparedOpening, repeatVariants } };
  const contentHash = `sha256:${createHash("sha256").update(JSON.stringify(version)).digest("hex")}`;
  return { ...scenario, version, contentHash };
}

function resumeDiscussionQuestion(record: PreparationRecord): string | null {
  const confirmed = new Set(record.confirmedFactIds);
  const fact = record.analysis?.facts.find((candidate) => confirmed.has(candidate.id));
  if (!fact) return null;
  // The question is deterministic and contains no resume text. Resume content
  // remains data and cannot smuggle instructions into the voice model.
  if (fact.category === "PROJECT") {
    return "Before you start coding, choose the confirmed project from your resume and briefly tell me what you personally owned and one tradeoff you made.";
  }
  if (fact.category === "EXPERIENCE") {
    return "Before you start coding, choose the confirmed experience from your resume and briefly tell me about one technical decision you made there.";
  }
  return "Before you start coding, choose the confirmed skill from your resume and briefly tell me where you used it in practice.";
}

function preparationId(params: unknown): string | null {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(params);
  return parsed.success ? parsed.data.id : null;
}

function preparationFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "PREPARATION_FAILED";
  return ["NO_ACTIVE_QUESTIONS", "PREPARATION_ALREADY_PINNED", "PINNED_QUESTION_UNAVAILABLE", "PREPARATION_STATE_CONFLICT", "PREPARATION_BUSY"]
    .includes(message) ? message : "PREPARATION_FAILED";
}

function safePreparationError(error: unknown): { name: string; message: string } {
  return { name: error instanceof Error ? error.name : "Error", message: preparationFailure(error) };
}
