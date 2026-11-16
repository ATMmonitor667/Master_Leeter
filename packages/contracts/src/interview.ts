import { z } from "zod";

/**
 * The live interview: one problem object and one interviewer prompt, shared by
 * voice and chat. The realtime model runs the conversation; the server pins the
 * problem and the prompt, stores the transcript and grades afterwards.
 */

export const InterviewFormatSchema = z.enum(["VOICE", "CHAT"]);
export type InterviewFormat = z.infer<typeof InterviewFormatSchema>;

/** One dial for how the interviewer behaves. Replaces mode + tone. */
export const INTERVIEW_STYLES = ["SUPPORTIVE", "NEUTRAL", "TOUGH"] as const;
export const InterviewStyleSchema = z.enum(INTERVIEW_STYLES);
export type InterviewStyle = z.infer<typeof InterviewStyleSchema>;

/** Hints the candidate may ask for, per style. */
export const HINTS_BY_STYLE: Record<InterviewStyle, number> = { SUPPORTIVE: 3, NEUTRAL: 2, TOUGH: 1 };

export const INTERVIEW_MINUTES = [30, 45, 60] as const;
export const InterviewMinutesSchema = z.union([z.literal(30), z.literal(45), z.literal(60)]);

const Json = z.unknown();

export const ProblemParamSchema = z.object({ name: z.string().min(1).max(40), type: z.string().min(1).max(80) });
export const ProblemSignatureSchema = z.object({
  name: z.string().regex(/^[a-z_][a-z0-9_]{0,39}$/),
  params: z.array(ProblemParamSchema).min(1).max(6),
  returns: z.string().min(1).max(80),
});
export type ProblemSignature = z.infer<typeof ProblemSignatureSchema>;

/** A test calls the function with `args` and compares the result with `expected`. */
export const ProblemTestSchema = z.object({
  args: z.array(Json).max(6),
  expected: Json,
  /** Hidden tests are run but their inputs are never shown. */
  hidden: z.boolean().default(false),
});
export type ProblemTest = z.infer<typeof ProblemTestSchema>;

/** Source examples are structured so a reskin can never change their values. */
export const SpecExampleSchema = z.object({ args: z.array(Json).max(6), expected: Json, note: z.string().max(300).optional() });
/** Rendered for people: `name = value, ...` using the session's parameter names. */
export const ProblemExampleSchema = z.object({
  input: z.string().min(1).max(600),
  output: z.string().min(1).max(300),
  note: z.string().max(300).optional(),
});

/** What an author (or a candidate pasting their own problem) supplies. */
export const ProblemSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  /** Never shown or spoken. Used to check the reskin does not name the problem. */
  title: z.string().min(1).max(120),
  concept: z.string().min(1).max(400),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
  topics: z.array(z.string().min(1).max(40)).min(1).max(6),
  statement: z.string().min(20).max(4_000),
  signature: ProblemSignatureSchema,
  constraints: z.array(z.string().min(1).max(300)).max(12),
  examples: z.array(SpecExampleSchema).min(1).max(5),
  tests: z.array(ProblemTestSchema).max(40),
  hints: z.array(z.string().min(1).max(400)).length(3),
  followUps: z.array(z.string().min(1).max(600)).length(2),
  privateNotes: z.object({
    approach: z.string().min(1).max(400),
    complexity: z.string().min(1).max(120),
    mistakes: z.array(z.string().min(1).max(300)).length(2),
  }),
  referenceSolution: z.string().max(8_000).optional(),
  provenance: z.object({ type: z.enum(["ORIGINAL", "LICENSED", "USER_SUPPLIED"]), author: z.string().min(1), notes: z.string().default("") }),
});
export type ProblemSpec = z.infer<typeof ProblemSpecSchema>;

/** The immutable problem a session runs against. Produced once at creation. */
export const InterviewProblemSchema = z.object({
  sourceId: z.string(),
  /** True when the reskin failed validation twice and the source wording is used. */
  fallback: z.boolean(),
  spokenBrief: z.string().min(20).max(1_500),
  writtenBrief: z.string().min(20).max(2_500),
  signature: ProblemSignatureSchema,
  constraints: z.array(z.string().min(1).max(300)).max(12),
  examples: z.array(ProblemExampleSchema).min(1).max(5),
  hints: z.array(z.string().min(1).max(400)).length(3),
  followUps: z.array(z.string().min(1).max(600)).length(2),
  privateNotes: ProblemSpecSchema.shape.privateNotes,
  tests: z.array(ProblemTestSchema).max(40),
  difficulty: ProblemSpecSchema.shape.difficulty,
  topics: ProblemSpecSchema.shape.topics,
});
export type InterviewProblem = z.infer<typeof InterviewProblemSchema>;

/** The part of the problem a browser may hold. No hints, notes, follow-ups or hidden tests. */
export interface PublicProblem {
  writtenBrief: string;
  signature: ProblemSignature;
  constraints: string[];
  examples: Array<{ input: string; output: string; note?: string | undefined }>;
  starterCode: string;
  visibleTests: number;
  totalTests: number;
}

export type Speaker = "CANDIDATE" | "INTERVIEWER";
export interface TranscriptEntry { seq: number; speaker: Speaker; text: string; at: string }

/** Cues the interview software (not the candidate) sends to the interviewer. */
export const CUE_KINDS = ["START", "HINT", "REPEAT", "DONE", "TIME", "QUIET", "RUN"] as const;
export const CueKindSchema = z.enum(CUE_KINDS);
export type CueKind = z.infer<typeof CueKindSchema>;

/** One batch of client-observed facts, appended to the event log in order. */
export const LiveEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("TRANSCRIPT"), id: z.string().min(1).max(80), speaker: z.enum(["CANDIDATE", "INTERVIEWER"]), text: z.string().trim().min(1).max(8_000), at: z.string().datetime() }),
  z.object({ type: z.literal("CODE"), id: z.string().min(1).max(80), revision: z.number().int().nonnegative(), text: z.string().max(100_000), at: z.string().datetime() }),
  z.object({ type: z.literal("NOTES"), id: z.string().min(1).max(80), text: z.string().max(20_000), at: z.string().datetime() }),
  z.object({ type: z.literal("CUE"), id: z.string().min(1).max(80), kind: CueKindSchema, n: z.number().int().min(0).max(99).optional(), at: z.string().datetime() }),
  z.object({ type: z.literal("LATENCY"), id: z.string().min(1).max(80), speechEndToFirstAudioMs: z.number().int().min(0).max(120_000), at: z.string().datetime() }),
]);
export type LiveEvent = z.infer<typeof LiveEventSchema>;
export const LiveEventBatchSchema = z.object({ events: z.array(LiveEventSchema).min(1).max(100) }).strict();

export const ChatTurnInputSchema = z.object({
  requestId: z.string().uuid(),
  /** Empty when a cue alone is sent (Hint, Repeat, Done, Start). */
  text: z.string().trim().max(8_000).default(""),
  cue: CueKindSchema.optional(),
  code: z.object({ revision: z.number().int().nonnegative(), text: z.string().max(100_000) }).optional(),
}).strict().refine((v) => Boolean(v.text) || Boolean(v.cue), "A turn needs text or a cue");
export type ChatTurnInput = z.infer<typeof ChatTurnInputSchema>;

export interface TestOutcome {
  index: number;
  passed: boolean;
  hidden: boolean;
  /** Present only for visible tests. */
  input?: string;
  expected?: string;
  got?: string;
  error?: string;
}
export interface RunReport {
  runId: string;
  revision: number;
  /** EXECUTED in a sandbox, or PREDICTED by a model that read the code. */
  method: "EXECUTED" | "PREDICTED";
  status: "PASSED" | "FAILED" | "ERROR";
  passed: number;
  total: number;
  outcomes: TestOutcome[];
  stderr: string;
  /** The one-line summary sent to the interviewer as a [RUN] cue. */
  summary: string;
}

/** Everything the interview room needs to render or restore itself. */
export interface RoomSnapshot {
  sessionId: string;
  format: InterviewFormat;
  style: InterviewStyle;
  language: string;
  problem: PublicProblem;
  started: boolean;
  ended: boolean;
  expectedSeconds: number;
  remainingSeconds: number;
  hintsAllowed: number;
  hintsUsed: number;
  transcript: TranscriptEntry[];
  code: { revision: number; text: string } | null;
  notes: string;
  lastRun: RunReport | null;
  liveAvailable: boolean;
  chatAvailable: boolean;
}

export interface LiveCredential {
  provider: "gemini";
  wsUrl: string;
  model: string;
  expiresAt: string;
}

/** Post-interview teaching conversation. Only accepted after the session ends. */
export const ReviewInputSchema = z.object({
  requestId: z.string().uuid(),
  /** Empty asks for the opening debrief. */
  question: z.string().trim().max(4_000).default(""),
}).strict();
export type ReviewInput = z.infer<typeof ReviewInputSchema>;
export interface ReviewTurn { requestId: string; question: string; reply: string; createdAt: string }
export const MAX_REVIEW_TURNS = 40;
export const MAX_CHAT_TURNS = 200;

/** The text of each cue. Voice sends it from the browser; chat builds it on the server. */
export function cueText(kind: string, n?: number): string {
  switch (kind) {
    case "START": return "[START] Begin the interview now.";
    case "HINT": return `[HINT ${n ?? 1}] The candidate asked for a hint.`;
    case "REPEAT": return "[REPEAT] The candidate asked you to restate the problem.";
    case "DONE": return "[DONE] The candidate says they are finished with this part.";
    case "TIME": return n && n > 0 ? `[TIME] ${n} minutes left. Mention it in one short sentence.` : "[TIME] Time is up. Wrap up now.";
    case "QUIET": return "[QUIET] No speech or edits for a while.";
    default: return `[${kind}]`;
  }
}

/** How the latest code is shown to the interviewer. Latest revision only, capped. */
export const CODE_CONTEXT_LIMIT = 6_000;
export function codeContext(revision: number, text: string): string {
  const body = text.length > CODE_CONTEXT_LIMIT ? `${text.slice(0, CODE_CONTEXT_LIMIT)}
# ... truncated` : text;
  return `[CODE rev ${revision}]
${body}`;
}
