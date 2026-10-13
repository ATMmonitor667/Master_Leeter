import { z } from "zod";

export const InterviewFormatSchema = z.enum(["VOICE", "CHAT"]);
export const ChatFocusSchema = z.enum(["CODING", "RESUME", "COMBINED"]);
export type ChatFocus = z.infer<typeof ChatFocusSchema>;
/** Private session metadata stored with the existing immutable session snapshot. */
export interface ChatSessionConfig { focus: ChatFocus; preparationId?: string }
/** Server-enforced conversation length; the schema bound only rejects nonsense. */
export const MAX_CHAT_TURNS = 200;
/** Interview lengths a candidate may choose. The server clock enforces them. */
export const INTERVIEW_MINUTES = [30, 45, 60, 90] as const;
export const InterviewMinutesSchema = z.union([z.literal(30), z.literal(45), z.literal(60), z.literal(90)]);
export const ChatInputSchema = z.object({
  requestId: z.string().uuid(),
  turn: z.number().int().min(1).max(10_000),
    // DONE asks the interviewer to move on: the server decides whether the base
  // solution has been demonstrated well enough to present a follow-up.
  kind: z.enum(["MESSAGE", "THOUGHTS", "CODE", "START_CODING", "HINT", "DONE"]),
  text: z.string().trim().max(12_000).default(""),
  code: z.string().max(100_000).optional(),
}).strict().refine((v) => v.kind === "START_CODING" || v.kind === "HINT" || v.kind === "DONE" ||
  (v.kind === "CODE" ? Boolean(v.code?.trim()) : Boolean(v.text)), "A submission cannot be empty");
export type ChatInput = z.infer<typeof ChatInputSchema>;
export interface ChatTurn {
  turn: number;
  requestId: string;
  kind: ChatInput["kind"] | "OPENING";
  text: string;
  code?: string;
  reply: string;
  phase: "RESUME" | "CODING";
  hintLevel?: number;
  factKey?: string;
  /** Set when this turn presented an authored follow-up requirement. */
  followUpId?: string;
  createdAt: string;
}
export interface ChatSnapshot {
  sessionId: string;
  focus: ChatFocus;
  phase: "RESUME" | "CODING";
  turns: ChatTurn[];
  nextTurn: number;
  remainingSeconds: number;
  ended: boolean;
  available: boolean;
  runs: RunResult[];
  expectedSeconds: number;
  /** Authored follow-ups presented so far, as their candidate-facing text. */
  requirements: string[];
  followUpsAvailable: number;
  /** Whether a post-session scorecard is produced (not for resume-only). */
  scored: boolean;
  review: ChatReviewTurn[];
  reviewAvailable: boolean;
}

/** Post-interview teaching conversation. Only accepted after the session ends. */
export const ChatReviewInputSchema = z.object({
  requestId: z.string().uuid(),
  turn: z.number().int().min(0).max(10_000),
  kind: z.enum(["DEBRIEF", "QUESTION"]),
  text: z.string().trim().max(4_000).default(""),
}).strict().refine((v) => v.kind === "DEBRIEF" || Boolean(v.text), "A question cannot be empty");
export type ChatReviewInput = z.infer<typeof ChatReviewInputSchema>;
export interface ChatReviewTurn {
  turn: number;
  requestId: string;
  kind: ChatReviewInput["kind"];
  text: string;
  reply: string;
  createdAt: string;
}
export const MAX_REVIEW_TURNS = 40;
import type { RunResult } from "./session-event.js";
