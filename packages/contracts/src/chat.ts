import { z } from "zod";

export const InterviewFormatSchema = z.enum(["VOICE", "CHAT"]);
export const ChatFocusSchema = z.enum(["CODING", "RESUME", "COMBINED"]);
export type ChatFocus = z.infer<typeof ChatFocusSchema>;
/** Private session metadata stored with the existing immutable session snapshot. */
export interface ChatSessionConfig { focus: ChatFocus; preparationId?: string }
/** Server-enforced conversation length; the schema bound only rejects nonsense. */
export const MAX_CHAT_TURNS = 200;
export const ChatInputSchema = z.object({
  requestId: z.string().uuid(),
  turn: z.number().int().min(1).max(10_000),
  kind: z.enum(["MESSAGE", "THOUGHTS", "CODE", "START_CODING", "HINT"]),
  text: z.string().trim().max(12_000).default(""),
  code: z.string().max(100_000).optional(),
}).strict().refine((v) => v.kind === "START_CODING" || v.kind === "HINT" ||
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
}
import type { RunResult } from "./session-event.js";
