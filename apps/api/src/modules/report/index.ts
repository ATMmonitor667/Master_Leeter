import type { FastifyInstance } from "fastify";
import { scenarioRef } from "../scenario/loader.js";
import type { EventLog } from "../session/event-log.js";
import { BaselineEvaluator, type Evaluator, type SessionReport } from "./evaluator.js";
import { InMemoryReportJobStore, type ReportJob, type ReportJobStore } from "./report-store.js";

export { extractFacts, momentsFor, type EvidenceMoment, type SessionFacts } from "./evidence.js";
export {
  BaselineEvaluator,
  weightedOverall,
  type DimensionScore,
  type Evaluator,
  type SessionReport,
} from "./evaluator.js";
export { CODING_RUBRIC_V1, rubricById, weightSum, type Rubric, type RubricDimension } from "./rubric.js";
export { InMemoryReportJobStore, type ReportClaim, type ReportJob, type ReportJobStore, type ReportStatus } from "./report-store.js";

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
  constructor(
    private readonly eventLog: EventLog,
    private readonly evaluator: Evaluator = new BaselineEvaluator(),
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly jobs: ReportJobStore = new InMemoryReportJobStore(),
  ) {}

  /** Idempotent: enqueuing a session already evaluated returns the existing job. */
  async enqueue(sessionId: string, rubricId: string): Promise<ReportJob> {
    const job = await this.jobs.enqueue(sessionId, rubricId, this.now());
    if (job.status === "QUEUED" || job.status === "RUNNING") void this.process(sessionId);
    return job;
  }

  async get(sessionId: string): Promise<ReportJob | null> {
    const job = await this.jobs.get(sessionId);
    if (job?.status === "QUEUED" || job?.status === "RUNNING") void this.process(sessionId);
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

  /**
   * Re-runs evaluation from the immutable events.
   *
   * This is why the log is append-only: improving the rubric re-scores every
   * past session without re-running a single interview.
   */
  async regenerate(sessionId: string, rubricId: string): Promise<ReportJob> {
    await this.jobs.delete(sessionId);
    const job = await this.enqueue(sessionId, rubricId);
    await this.settled(sessionId);
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
    const leaseExpiresAt = new Date(Date.parse(now) + 60_000).toISOString();
    const claim = await this.jobs.claim(sessionId, now, leaseExpiresAt);
    if (!claim) return;

    try {
      const events = await this.eventLog.read(sessionId);
      if (events.length === 0) throw new Error("no events for session");
      const report = await this.evaluator.evaluate(events, claim.job.rubricId);
      await this.jobs.complete(sessionId, claim.token, report, this.now());
    } catch (err) {
      // A failed evaluation never affects the completed interview. The job is
      // retryable from the same immutable events.
      await this.jobs.fail(sessionId, claim.token, (err as Error).message, this.now());
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
      return reply.code(job.status === "FAILED" ? 500 : 202).send({
        status: job.status,
        error: job.error,
        attempts: job.attempts,
      });
    }

    return reply.send({ status: job.status, report: toPublicReport(job.report) });
  });

  app.post("/interview-sessions/:id/report/regenerate", async (req, reply) => {
    // Author/admin only once auth lands (M2-8).
    const { id } = req.params as { id: string };
    const job = await queue.regenerate(id, "rubric-coding-v1");
    return reply.code(job.status === "READY" ? 200 : 500).send({ status: job.status, error: job.error });
  });
}

declare module "fastify" {
  interface FastifyInstance {
    evaluationQueue: EvaluationQueue;
  }
}
