import type { FastifyInstance } from "fastify";
import { scenarioRef } from "../scenario/loader.js";
import type { EventLog } from "../session/event-log.js";
import type { SessionStore } from "../session/session-store.js";
import { BaselineEvaluator, type Evaluator, type SessionReport } from "./evaluator.js";
import { InMemoryReportJobStore, MAX_REPORT_ATTEMPTS, reportRetryAt, type ReportJob, type ReportJobStore } from "./report-store.js";

const REPORT_LEASE_MS = 3 * 60_000;

export { extractFacts, momentsFor, type EvidenceMoment, type SessionFacts } from "./evidence.js";
export {
  BaselineEvaluator,
  weightedOverall,
  type DimensionScore,
  type EvaluationContext,
  type EvaluationProgress,
  type Evaluator,
  type GradeCitation,
  type GradeDimension,
  type IndependentGrade,
  type SessionReport,
} from "./evaluator.js";
export { CODING_RUBRIC_V1, rubricById, weightSum, type Rubric, type RubricDimension } from "./rubric.js";
export { InMemoryReportJobStore, type ReportClaim, type ReportJob, type ReportJobStore, type ReportStatus } from "./report-store.js";
export { IndependentGeminiEvaluator, SOLUTION_PROMPT_VERSION, TRANSCRIPT_PROMPT_VERSION } from "./independent-evaluator.js";

/**
 * Report module — post-session evaluation.
 *
 * A queue consumer over the immutable event log. It cannot block, touch, or read
 * into the live session path (ADR-004). Every score cites evidence, and reports
 * evaluate observable interview behavior only.
 */

/**
 * Evaluation queue.
 *
 * Deliberately separate from the run queue and from the session module. If a
 * change ever requires the evaluator to reach into a live session, the
 * separation the whole scoring design rests on has broken.
 */
export class EvaluationQueue {
  private readonly active = new Map<string, Promise<void>>();
  constructor(
    private readonly eventLog: EventLog,
    private readonly evaluator: Evaluator = new BaselineEvaluator(),
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly jobs: ReportJobStore = new InMemoryReportJobStore(),
    private readonly scenarioFor?: ((sessionId: string) => ReturnType<SessionStore["pinnedScenario"]>) | undefined,
  ) {}

  /** Idempotent: enqueuing a session already evaluated returns the existing job. */
  async enqueue(sessionId: string, rubricId: string): Promise<ReportJob> {
    const job = await this.jobs.enqueue(sessionId, rubricId, this.now());
    if (job.status === "QUEUED" || job.status === "RUNNING") this.background(sessionId);
    return job;
  }

  async get(sessionId: string): Promise<ReportJob | null> {
    const job = await this.jobs.get(sessionId);
    // Provider failures are retried from checkpointed grader progress. Bound the
    // attempts so a polling report page cannot create an unbounded cost loop.
    if (job?.status === "QUEUED" || job?.status === "RUNNING" ||
        (job?.status === "FAILED" && job.attempts < MAX_REPORT_ATTEMPTS && reportRetryAt(job) <= Date.parse(this.now()))) {
      this.background(sessionId);
    }
    return job;
  }

  /**
   * Drops a generated report (M7-3).
   *
   * Reports are derived data — regenerable from events while those exist, and
   * meaningless once they are redacted. Deleting one destroys nothing that the
   * event log does not already hold.
   */
  async forget(sessionId: string): Promise<boolean> {
    return this.jobs.delete(sessionId);
  }

  /** Claim atomically in the store; concurrent workers may discover the same IDs. */
  async recover(limit = 10): Promise<void> {
    const ids = await this.jobs.recoverable(this.now(), limit);
    const results = await Promise.allSettled(ids.map((id) => this.run(id)));
    if (results.some((result) => result.status === "rejected")) throw new Error("REPORT_RECOVERY_FAILED");
  }

  async drain(): Promise<void> { await Promise.allSettled([...this.active.values()]); }

  private background(sessionId: string): void {
    // A DB outage must not become an unhandled rejection. The durable job stays
    // eligible for the next recovery pass, which reports errors to the operator.
    void this.run(sessionId).catch(() => {});
  }

  private run(sessionId: string): Promise<void> {
    const existing = this.active.get(sessionId);
    if (existing) return existing;
    const task = this.process(sessionId).finally(() => this.active.delete(sessionId));
    this.active.set(sessionId, task);
    return task;
  }

  /**
   * Re-runs evaluation from the immutable events.
   *
   * This is why the log is append-only: improving the rubric re-scores every
   * past session without re-running a single interview.
   */
  async regenerate(sessionId: string, rubricId: string, wait = true): Promise<ReportJob> {
    await this.jobs.delete(sessionId);
    const job = await this.enqueue(sessionId, rubricId);
    if (wait) await this.settled(sessionId);
    return (await this.jobs.get(sessionId)) ?? job;
  }

  /** Test/observability helper — resolves once the job is no longer in flight. */
  async settled(sessionId: string): Promise<ReportJob | null> {
    for (let i = 0; i < 200; i++) {
      const job = await this.jobs.get(sessionId);
      if (job && (job.status === "READY" || job.status === "FAILED")) return job;
      await new Promise((r) => setTimeout(r, 5));
    }
    return (await this.jobs.get(sessionId)) ?? null;
  }

  private async process(sessionId: string): Promise<void> {
    const now = this.now();
    // Two independent provider calls may each consume their 45-second timeout.
    // The lease must cover both or a healthy worker can be replaced mid-grade.
    const leaseExpiresAt = new Date(Date.parse(now) + REPORT_LEASE_MS).toISOString();
    const claim = await this.jobs.claim(sessionId, now, leaseExpiresAt);
    if (!claim) return;

    try {
      const events = await this.eventLog.read(sessionId);
      if (events.length === 0) throw new Error("no events for session");
      const scenario = await this.scenarioFor?.(sessionId);
      const context = scenario === undefined ? {} : { scenario };
      const report = this.evaluator.evaluateWithProgress
        ? await this.evaluator.evaluateWithProgress(
          events,
          claim.job.rubricId,
          context,
          claim.job.progress,
          async (progress) => {
            if (!await this.jobs.saveProgress(sessionId, claim.token, progress)) {
              throw new Error("REPORT_LEASE_LOST");
            }
          },
        )
        : await this.evaluator.evaluate(events, claim.job.rubricId, context);
      await this.jobs.complete(sessionId, claim.token, report, this.now());
    } catch {
      // A failed evaluation never affects the completed interview. The job is
      // retryable from the same immutable events.
      await this.jobs.fail(sessionId, claim.token, "EVALUATION_FAILED", this.now());
    }
  }
}

export interface ReportModuleOptions {
  eventLog: EventLog;
  queue?: EvaluationQueue;
}

/**
 * Strips the internal scenario id before a report leaves the server.
 *
 * The report is a candidate-facing artifact, and `conveyor-rescan@1` names the
 * problem. Internally the id is what makes a report traceable to the exact
 * content version it scored; externally the opaque ref carries the same
 * correlation value without the giveaway. Same reasoning as the catalogue.
 */
export function toPublicReport(report: SessionReport | null) {
  if (!report) return null;
  const { scenarioVersionId, ...rest } = report;
  return { ...rest, scenarioRef: scenarioRef(scenarioVersionId) };
}

export async function registerReportModule(
  app: FastifyInstance,
  opts: ReportModuleOptions,
): Promise<void> {
  const queue = opts.queue ?? new EvaluationQueue(opts.eventLog);

  app.get("/interview-sessions/:id/report", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await queue.get(id);

    if (!job) return reply.code(404).send({ error: "NO_REPORT", message: "Session has not been evaluated." });

    if (job.status !== "READY") {
      // 202 while in flight: the report is coming, and the client should poll
      // rather than treat this as an error.
      const retrying = job.status === "FAILED" && job.attempts < MAX_REPORT_ATTEMPTS;
      return reply.code(job.status === "FAILED" && !retrying ? 500 : 202).send({
        status: retrying ? "RETRYING" : job.status,
        error: job.error,
        attempts: job.attempts,
      });
    }

    return reply.send({ status: job.status, report: toPublicReport(job.report) });
  });

  app.post("/interview-sessions/:id/report/regenerate", async (req, reply) => {
    // Author/admin only once auth lands (M2-8).
    const { id } = req.params as { id: string };
    const job = await queue.regenerate(id, "rubric-coding-v1", false);
    const status = job.status === "READY" ? 200 : job.status === "FAILED" ? 500 : 202;
    return reply.code(status).send({ status: job.status, error: job.error });
  });
}

declare module "fastify" {
  interface FastifyInstance {
    evaluationQueue: EvaluationQueue;
  }
}
