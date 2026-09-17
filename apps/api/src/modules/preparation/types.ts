import { InterviewerToneSchema, type InterviewerTone } from "@master-leeter/contracts";
import { z } from "zod";

export { InterviewerToneSchema, type InterviewerTone };

export const ResumeFactCategorySchema = z.enum(["SKILL", "PROJECT", "EXPERIENCE"]);
export type ResumeFactCategory = z.infer<typeof ResumeFactCategorySchema>;

export const ResumeFactSchema = z.object({
  id: z.string().uuid(),
  category: ResumeFactCategorySchema,
  claim: z.string().min(1).max(500),
  /** Exact text copied from the submitted resume. */
  evidence: z.string().min(1).max(1_000),
});
export type ResumeFact = z.infer<typeof ResumeFactSchema>;

export const ResumeAnalysisSchema = z.object({
  summary: z.string().max(2_000),
  facts: z.array(ResumeFactSchema).max(40),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
});
export type ResumeAnalysis = z.infer<typeof ResumeAnalysisSchema>;

export const RestatementSchema = z.object({
  openingScript: z.string().min(1).max(8_000),
  repeatVariants: z.array(z.string().min(1).max(4_000)).min(1).max(3),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  fallback: z.boolean(),
  rejectionReason: z.string().max(200).nullable(),
});
export type Restatement = z.infer<typeof RestatementSchema>;

export const PREPARATION_STATUSES = ["ANALYZING", "REVIEW", "CONFIRMED", "READY", "DELETED"] as const;
export const PreparationStatusSchema = z.enum(PREPARATION_STATUSES);
export type PreparationStatus = z.infer<typeof PreparationStatusSchema>;

export interface PreparationRecord {
  id: string;
  userId: string;
  idempotencyKey: string;
  tone: InterviewerTone;
  status: PreparationStatus;
  consentedAt: string;
  noticeVersion: string;
  resumeText: string | null;
  resumeExpiresAt: string;
  analysis: ResumeAnalysis | null;
  confirmedFactIds: string[];
  scenarioVersionId: string | null;
  scenarioHash: string | null;
  restatement: Restatement | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Candidate projection excludes raw resumes and private oral scenario content. */
export interface PublicPreparation {
  id: string;
  tone: InterviewerTone;
  status: PreparationStatus;
  hasResume: boolean;
  analysis: ResumeAnalysis | null;
  confirmedFactIds: string[];
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function publicPreparation(record: PreparationRecord): PublicPreparation {
  return {
    id: record.id,
    tone: record.tone,
    status: record.status,
    hasResume: record.resumeText !== null && record.resumeExpiresAt > new Date().toISOString(),
    analysis: record.analysis,
    confirmedFactIds: [...record.confirmedFactIds],
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
