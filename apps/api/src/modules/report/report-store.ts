import { randomUUID } from "node:crypto";
import type { SessionReport } from "./evaluator.js";

export type ReportStatus = "QUEUED" | "RUNNING" | "READY" | "FAILED";

export interface ReportJob {
  sessionId: string;
  status: ReportStatus;
  rubricId: string;
  report: SessionReport | null;
  error: string | null;
  attempts: number;
  queuedAt: string;
  completedAt: string | null;
}

export interface ReportClaim { token: string; job: ReportJob }

export interface ReportJobStore {
  enqueue(sessionId: string, rubricId: string, queuedAt: string): Promise<ReportJob>;
  get(sessionId: string): Promise<ReportJob | null>;
  claim(sessionId: string, now: string, leaseExpiresAt: string): Promise<ReportClaim | null>;
  complete(sessionId: string, token: string, report: SessionReport, completedAt: string): Promise<ReportJob | null>;
  fail(sessionId: string, token: string, error: string, completedAt: string): Promise<ReportJob | null>;
  delete(sessionId: string): Promise<boolean>;
}

interface StoredJob extends ReportJob {
  leaseToken: string | null;
  leaseExpiresAt: string | null;
}

export class InMemoryReportJobStore implements ReportJobStore {
  private readonly jobs = new Map<string, StoredJob>();

  async enqueue(sessionId: string, rubricId: string, queuedAt: string): Promise<ReportJob> {
    const existing = this.jobs.get(sessionId);
    if (existing && existing.status !== "FAILED") return this.public(existing);
    const job: StoredJob = {
      sessionId,
      status: "QUEUED",
      rubricId,
      report: null,
      error: null,
      attempts: existing?.attempts ?? 0,
      queuedAt,
      completedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    this.jobs.set(sessionId, job);
    return this.public(job);
  }

  async get(sessionId: string): Promise<ReportJob | null> {
    const job = this.jobs.get(sessionId);
    return job ? this.public(job) : null;
  }

  async claim(sessionId: string, now: string, leaseExpiresAt: string): Promise<ReportClaim | null> {
    const job = this.jobs.get(sessionId);
    if (!job || (job.status !== "QUEUED" && !(job.status === "RUNNING" && (!job.leaseExpiresAt || job.leaseExpiresAt <= now)))) return null;
    job.status = "RUNNING";
    job.attempts += 1;
    job.error = null;
    job.completedAt = null;
    job.leaseToken = randomUUID();
    job.leaseExpiresAt = leaseExpiresAt;
    return { token: job.leaseToken, job: this.public(job) };
  }

  async complete(sessionId: string, token: string, report: SessionReport, completedAt: string): Promise<ReportJob | null> {
    const job = this.claimed(sessionId, token);
    if (!job) return null;
    job.status = "READY";
    job.report = structuredClone(report);
    job.error = null;
    job.completedAt = completedAt;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    return this.public(job);
  }

  async fail(sessionId: string, token: string, error: string, completedAt: string): Promise<ReportJob | null> {
    const job = this.claimed(sessionId, token);
    if (!job) return null;
    job.status = "FAILED";
    job.error = error;
    job.completedAt = completedAt;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    return this.public(job);
  }

  async delete(sessionId: string): Promise<boolean> { return this.jobs.delete(sessionId); }

  private claimed(sessionId: string, token: string): StoredJob | null {
    const job = this.jobs.get(sessionId);
    return job?.status === "RUNNING" && job.leaseToken === token ? job : null;
  }

  private public(job: StoredJob): ReportJob {
    const { leaseToken: _token, leaseExpiresAt: _expires, ...result } = job;
    return structuredClone(result);
  }
}
