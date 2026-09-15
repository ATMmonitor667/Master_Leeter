import { z } from "zod";

/** Presentation style only. Assistance and grading policy remain independent. */
export const INTERVIEWER_TONES = ["EXTRA_NICE", "NORMAL", "MEAN"] as const;
export const InterviewerToneSchema = z.enum(INTERVIEWER_TONES);
export type InterviewerTone = z.infer<typeof InterviewerToneSchema>;
