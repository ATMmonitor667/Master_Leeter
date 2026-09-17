import { randomUUID } from "node:crypto";
import type { InterviewerTone, PreparationRecord, Restatement, ResumeAnalysis } from "./types.js";

export interface CreatePreparation {
  userId: string;
  idempotencyKey: string;
  resumeText: string;
  tone: InterviewerTone;
  noticeVersion: string;
  resumeExpiresAt: string;
}

export interface PreparationStore {
  create(input: CreatePreparation): Promise<{ record: PreparationRecord; created: boolean }>;
  get(id: string): Promise<PreparationRecord | null>;
  claimAnalysis(id: string, token: string, staleBefore: string): Promise<boolean>;
  releaseAnalysis(id: string, token: string): Promise<void>;
  saveAnalysis(id: string, analysis: ResumeAnalysis, token: string): Promise<PreparationRecord>;
  confirmFacts(id: string, factIds: string[]): Promise<PreparationRecord>;
  pinScenario(id: string, versionId: string, hash: string): Promise<PreparationRecord>;
  claimRestatement(id: string, token: string, staleBefore: string): Promise<boolean>;
  releaseRestatement(id: string, token: string): Promise<void>;
  saveRestatement(id: string, restatement: Restatement, token: string): Promise<PreparationRecord>;
  complete(id: string, restatement: Restatement, sessionId: string): Promise<PreparationRecord>;
  deleteResume(id: string): Promise<PreparationRecord>;
  delete(id: string): Promise<boolean>;
  deleteForSession(sessionId: string): Promise<number>;
  deleteForUser(userId: string): Promise<number>;
  purgeExpiredResumes(at: string): Promise<number>;
}

export class InMemoryPreparationStore implements PreparationStore {
  private readonly records = new Map<string, PreparationRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly analysisClaims = new Map<string, { token: string; at: number }>();
  private readonly restatementClaims = new Map<string, { token: string; at: number }>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async create(input: CreatePreparation): Promise<{ record: PreparationRecord; created: boolean }> {
    const key = JSON.stringify([input.userId, input.idempotencyKey]);
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (existing?.status === "DELETED") throw new Error("PREPARATION_DELETED");
      if (existing) return { record: structuredClone(existing), created: false };
    }
    const at = this.now();
    const record: PreparationRecord = {
      id: randomUUID(), userId: input.userId, idempotencyKey: input.idempotencyKey,
      tone: input.tone, status: "ANALYZING", consentedAt: at,
      noticeVersion: input.noticeVersion, resumeText: input.resumeText,
      resumeExpiresAt: input.resumeExpiresAt,
      analysis: null, confirmedFactIds: [], scenarioVersionId: null,
      scenarioHash: null, restatement: null, sessionId: null,
      createdAt: at, updatedAt: at,
    };
    this.records.set(record.id, record);
    this.idempotency.set(key, record.id);
    return { record: structuredClone(record), created: true };
  }

  async get(id: string): Promise<PreparationRecord | null> {
    const record = this.records.get(id);
    return record && record.status !== "DELETED" ? structuredClone(record) : null;
  }

  async claimAnalysis(id: string, token: string, staleBefore: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.status !== "ANALYZING" || record.resumeText === null || record.resumeExpiresAt <= this.now()) return false;
    const existing = this.analysisClaims.get(id);
    if (existing && existing.at >= Date.parse(staleBefore)) return false;
    this.analysisClaims.set(id, { token, at: Date.now() });
    return true;
  }

  async saveAnalysis(id: string, analysis: ResumeAnalysis, token: string): Promise<PreparationRecord> {
    const record = this.records.get(id);
    if (!record || record.status !== "ANALYZING" || record.resumeText === null || record.resumeExpiresAt <= this.now()) throw new Error("PREPARATION_CLAIM_LOST");
    if (this.analysisClaims.get(id)?.token !== token) throw new Error("PREPARATION_CLAIM_LOST");
    this.analysisClaims.delete(id);
    return this.update(id, (record) => ({ ...record, analysis, status: "REVIEW", updatedAt: this.now() }));
  }

  async releaseAnalysis(id: string, token: string): Promise<void> {
    if (this.analysisClaims.get(id)?.token === token) this.analysisClaims.delete(id);
  }

  async confirmFacts(id: string, factIds: string[]): Promise<PreparationRecord> {
    return this.update(id, (record) => ({ ...record, confirmedFactIds: [...factIds], status: "CONFIRMED", updatedAt: this.now() }));
  }

  async pinScenario(id: string, versionId: string, hash: string): Promise<PreparationRecord> {
    return this.update(id, (record) => {
      if (record.scenarioVersionId &&
          (record.scenarioVersionId !== versionId || record.scenarioHash !== hash)) throw new Error("PREPARATION_ALREADY_PINNED");
      return { ...record, scenarioVersionId: versionId, scenarioHash: hash, updatedAt: this.now() };
    });
  }

  async claimRestatement(id: string, token: string, staleBefore: string): Promise<boolean> {
    const existing = this.restatementClaims.get(id);
    if (existing && existing.at >= Date.parse(staleBefore)) return false;
    this.restatementClaims.set(id, { token, at: Date.now() });
    return true;
  }

  async saveRestatement(id: string, restatement: Restatement, token: string): Promise<PreparationRecord> {
    if (this.restatementClaims.get(id)?.token !== token) throw new Error("PREPARATION_CLAIM_LOST");
    this.restatementClaims.delete(id);
    return this.update(id, (record) => ({ ...record, restatement, updatedAt: this.now() }));
  }

  async releaseRestatement(id: string, token: string): Promise<void> {
    if (this.restatementClaims.get(id)?.token === token) this.restatementClaims.delete(id);
  }

  async complete(id: string, restatement: Restatement, sessionId: string): Promise<PreparationRecord> {
    return this.update(id, (record) => {
      if (record.sessionId && record.sessionId !== sessionId) throw new Error("PREPARATION_ALREADY_COMPLETED");
      return { ...record, restatement, sessionId, status: "READY", updatedAt: this.now() };
    });
  }

  async deleteResume(id: string): Promise<PreparationRecord> {
    this.analysisClaims.delete(id);
    return this.update(id, (record) => ({ ...record, resumeText: null, updatedAt: this.now() }));
  }

  async delete(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.status === "DELETED") return false;
    this.records.set(id, { ...record, resumeText: null, analysis: null, confirmedFactIds: [], status: "DELETED", updatedAt: this.now() });
    this.analysisClaims.delete(id);
    this.restatementClaims.delete(id);
    return true;
  }

  async deleteForUser(userId: string): Promise<number> {
    let deleted = 0;
    for (const record of this.records.values()) {
      if (record.userId === userId && record.status !== "DELETED" && await this.delete(record.id)) deleted += 1;
    }
    return deleted;
  }

  async deleteForSession(sessionId: string): Promise<number> {
    const match = [...this.records.values()].find((record) => record.sessionId === sessionId && record.status !== "DELETED");
    return match && await this.delete(match.id) ? 1 : 0;
  }

  async purgeExpiredResumes(at: string): Promise<number> {
    let purged = 0;
    for (const record of this.records.values()) {
      if (record.resumeText !== null && record.resumeExpiresAt <= at) {
        this.analysisClaims.delete(record.id);
        this.records.set(record.id, { ...record, resumeText: null, updatedAt: this.now() });
        purged += 1;
      }
    }
    return purged;
  }

  private update(id: string, apply: (record: PreparationRecord) => PreparationRecord): PreparationRecord {
    const current = this.records.get(id);
    if (!current || current.status === "DELETED") throw new Error("PREPARATION_NOT_FOUND");
    const next = apply(current);
    this.records.set(id, next);
    return structuredClone(next);
  }
}
