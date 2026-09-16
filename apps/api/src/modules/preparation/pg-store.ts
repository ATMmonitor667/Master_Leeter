import { randomUUID } from "node:crypto";
import type { QueryClient } from "../session/pg-event-log.js";
import type { CreatePreparation, PreparationStore } from "./store.js";
import {
  InterviewerToneSchema,
  PreparationStatusSchema,
  RestatementSchema,
  ResumeAnalysisSchema,
  type PreparationRecord,
  type Restatement,
  type ResumeAnalysis,
} from "./types.js";

type Row = {
  id: string; user_id: string; idempotency_key: string; tone: string; status: string;
  consented_at: Date | string; notice_version: string; resume_text: string | null;
  resume_expires_at: Date | string;
  analysis: unknown; confirmed_fact_ids: unknown; scenario_version_id: string | null;
  scenario_hash: string | null; restatement: unknown; session_id: string | null;
  created_at: Date | string; updated_at: Date | string;
};

function record(row: Row): PreparationRecord {
  return {
    id: row.id, userId: row.user_id, idempotencyKey: row.idempotency_key,
    tone: InterviewerToneSchema.parse(row.tone), status: PreparationStatusSchema.parse(row.status),
    consentedAt: new Date(row.consented_at).toISOString(), noticeVersion: row.notice_version,
    resumeText: row.resume_text,
    resumeExpiresAt: new Date(row.resume_expires_at).toISOString(),
    analysis: row.analysis === null ? null : ResumeAnalysisSchema.parse(row.analysis),
    confirmedFactIds: Array.isArray(row.confirmed_fact_ids)
      ? row.confirmed_fact_ids.filter((value): value is string => typeof value === "string") : [],
    scenarioVersionId: row.scenario_version_id, scenarioHash: row.scenario_hash,
    restatement: row.restatement === null ? null : RestatementSchema.parse(row.restatement),
    sessionId: row.session_id, createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class PgPreparationStore implements PreparationStore {
  constructor(private readonly db: QueryClient) {}

  async create(input: CreatePreparation): Promise<{ record: PreparationRecord; created: boolean }> {
    const prior = await this.findByKey(input.userId, input.idempotencyKey);
    if (prior) {
      if (prior.status === "DELETED") throw new Error("PREPARATION_DELETED");
      return { record: prior, created: false };
    }
    const id = randomUUID();
    const result = await this.db.query<Row>(`
      INSERT INTO public.interview_preparations
      (id,user_id,idempotency_key,tone,status,consented_at,notice_version,resume_text,resume_expires_at)
      VALUES ($1::uuid,$2,$3,$4,'ANALYZING',now(),$5,$6,$7::timestamptz)
      ON CONFLICT (user_id,idempotency_key) DO NOTHING RETURNING *`,
    [id, input.userId, input.idempotencyKey, input.tone, input.noticeVersion, input.resumeText, input.resumeExpiresAt]);
    if (result.rows[0]) return { record: record(result.rows[0]), created: true };
    const winner = await this.findByKey(input.userId, input.idempotencyKey);
    if (!winner || winner.status === "DELETED") throw new Error("PREPARATION_CREATE_CONFLICT");
    return { record: winner, created: false };
  }

  async get(id: string): Promise<PreparationRecord | null> {
    const { rows } = await this.db.query<Row>("SELECT * FROM public.interview_preparations WHERE id=$1::uuid AND status<>'DELETED'", [id]);
    return rows[0] ? record(rows[0]) : null;
  }

  async claimAnalysis(id: string, token: string, staleBefore: string): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(`UPDATE public.interview_preparations SET
      analysis_token=$2::uuid,analysis_started_at=now(),updated_at=now()
      WHERE id=$1::uuid AND status='ANALYZING'
        AND (analysis_token IS NULL OR analysis_started_at<$3::timestamptz) RETURNING id`, [id, token, staleBefore]);
    return Boolean(result.rows[0]);
  }

  async saveAnalysis(id: string, analysis: ResumeAnalysis, token: string): Promise<PreparationRecord> {
    return this.update(id, `UPDATE public.interview_preparations SET analysis=$2::jsonb,status='REVIEW',
      analysis_token=NULL,analysis_started_at=NULL,updated_at=now()
      WHERE id=$1::uuid AND status='ANALYZING' AND analysis_token=$3::uuid RETURNING *`, [id, JSON.stringify(analysis), token]);
  }

  async releaseAnalysis(id: string, token: string): Promise<void> {
    await this.db.query(`UPDATE public.interview_preparations SET analysis_token=NULL,analysis_started_at=NULL,updated_at=now()
      WHERE id=$1::uuid AND status='ANALYZING' AND analysis_token=$2::uuid`, [id, token]);
  }

  async confirmFacts(id: string, factIds: string[]): Promise<PreparationRecord> {
    return this.update(id, `UPDATE public.interview_preparations SET confirmed_fact_ids=$2::jsonb,status='CONFIRMED',updated_at=now()
      WHERE id=$1::uuid AND status='REVIEW' RETURNING *`, [id, JSON.stringify(factIds)]);
  }

  async pinScenario(id: string, versionId: string, hash: string): Promise<PreparationRecord> {
    const current = await this.get(id);
    if (!current) throw new Error("PREPARATION_NOT_FOUND");
    if (current.scenarioVersionId) {
      if (current.scenarioVersionId !== versionId || current.scenarioHash !== hash) throw new Error("PREPARATION_ALREADY_PINNED");
      return current;
    }
    return this.update(id, `UPDATE public.interview_preparations SET scenario_version_id=$2,scenario_hash=$3,updated_at=now()
      WHERE id=$1::uuid AND status='CONFIRMED' AND scenario_version_id IS NULL RETURNING *`, [id, versionId, hash]);
  }

  async claimRestatement(id: string, token: string, staleBefore: string): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(`UPDATE public.interview_preparations SET
      restatement_token=$2::uuid,restatement_started_at=now(),updated_at=now()
      WHERE id=$1::uuid AND status='CONFIRMED' AND restatement IS NULL
        AND (restatement_token IS NULL OR restatement_started_at<$3::timestamptz) RETURNING id`, [id, token, staleBefore]);
    return Boolean(result.rows[0]);
  }

  async saveRestatement(id: string, restatement: Restatement, token: string): Promise<PreparationRecord> {
    return this.update(id, `UPDATE public.interview_preparations SET restatement=$2::jsonb,
      restatement_token=NULL,restatement_started_at=NULL,updated_at=now()
      WHERE id=$1::uuid AND status='CONFIRMED' AND restatement_token=$3::uuid RETURNING *`,
    [id, JSON.stringify(restatement), token]);
  }

  async releaseRestatement(id: string, token: string): Promise<void> {
    await this.db.query(`UPDATE public.interview_preparations SET restatement_token=NULL,restatement_started_at=NULL,updated_at=now()
      WHERE id=$1::uuid AND status='CONFIRMED' AND restatement_token=$2::uuid`, [id, token]);
  }

  async complete(id: string, restatement: Restatement, sessionId: string): Promise<PreparationRecord> {
    const current = await this.get(id);
    if (current?.sessionId) {
      if (current.sessionId !== sessionId) throw new Error("PREPARATION_ALREADY_COMPLETED");
      return current;
    }
    return this.update(id, `UPDATE public.interview_preparations SET restatement=$2::jsonb,session_id=$3::uuid,status='READY',updated_at=now()
      WHERE id=$1::uuid AND status='CONFIRMED' AND scenario_version_id IS NOT NULL RETURNING *`,
    [id, JSON.stringify(restatement), sessionId]);
  }

  async deleteResume(id: string): Promise<PreparationRecord> {
    return this.update(id, "UPDATE public.interview_preparations SET resume_text=NULL,updated_at=now() WHERE id=$1::uuid AND status<>'DELETED' RETURNING *", [id]);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.query<Row>(`UPDATE public.interview_preparations SET
      resume_text=NULL,analysis=NULL,confirmed_fact_ids='[]'::jsonb,
      analysis_token=NULL,analysis_started_at=NULL,restatement_token=NULL,restatement_started_at=NULL,
      status='DELETED',updated_at=now()
      WHERE id=$1::uuid AND status<>'DELETED' RETURNING *`, [id]);
    return Boolean(result.rows[0]);
  }

  async deleteForUser(userId: string): Promise<number> {
    const result = await this.db.query<{ id: string }>(`UPDATE public.interview_preparations SET
      resume_text=NULL,analysis=NULL,confirmed_fact_ids='[]'::jsonb,
      analysis_token=NULL,analysis_started_at=NULL,restatement_token=NULL,restatement_started_at=NULL,
      status='DELETED',updated_at=now()
      WHERE user_id=$1 AND status<>'DELETED' RETURNING id`, [userId]);
    return result.rows.length;
  }

  async deleteForSession(sessionId: string): Promise<number> {
    const result = await this.db.query<{ id: string }>(`UPDATE public.interview_preparations SET
      resume_text=NULL,analysis=NULL,confirmed_fact_ids='[]'::jsonb,
      analysis_token=NULL,analysis_started_at=NULL,restatement_token=NULL,restatement_started_at=NULL,
      status='DELETED',updated_at=now()
      WHERE session_id=$1::uuid AND status<>'DELETED' RETURNING id`, [sessionId]);
    return result.rows.length;
  }

  async purgeExpiredResumes(at: string): Promise<number> {
    const result = await this.db.query<{ id: string }>(`UPDATE public.interview_preparations SET
      resume_text=NULL,updated_at=now() WHERE resume_text IS NOT NULL AND resume_expires_at<=$1::timestamptz
      RETURNING id`, [at]);
    return result.rows.length;
  }

  private async findByKey(userId: string, key: string): Promise<PreparationRecord | null> {
    const { rows } = await this.db.query<Row>("SELECT * FROM public.interview_preparations WHERE user_id=$1 AND idempotency_key=$2", [userId, key]);
    return rows[0] ? record(rows[0]) : null;
  }

  private async update(_id: string, sql: string, values: unknown[]): Promise<PreparationRecord> {
    const { rows } = await this.db.query<Row>(sql, values);
    if (!rows[0]) throw new Error("PREPARATION_STATE_CONFLICT");
    return record(rows[0]);
  }
}
