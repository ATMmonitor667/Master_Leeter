import {
  type CandidateState,
  type GateDecision,
  type InterviewAction,
  type InterviewScenarioVersion,
  type InterviewState,
  isActionAllowed,
} from "@master-leeter/contracts";
import { getClarificationFact } from "../scenario/clarification.js";
import { selectProbeWording } from "../scenario/probes.js";

/**
 * Voice agent tool surface (M3-3).
 *
 * The realtime model's entire access to this system. Five tools, no database
 * handle, no scenario object, no query language — everything it can learn or do
 * passes through the functions below, and every one of them checks permission
 * before it answers.
 *
 * ── Why state permission is not enough ─────────────────────────────────────
 *
 * The obvious design checks `isActionAllowed(state, action)` and stops there.
 * That would be a real boundary and still the wrong one, because it makes the
 * *model* the thing deciding when to speak: `ASK_PROBE` is permitted throughout
 * IMPLEMENTATION, so a model that felt chatty could pull probe wording whenever
 * it liked and read it out. The Response Gate would never be consulted. That is
 * precisely the architecture CLAUDE.md calls drift — "if you find yourself
 * relying on the model's prompt to keep it quiet".
 *
 * So the speaking tools require **two** things: the stage must permit the
 * action, and the gate must have authorized *that specific action this turn*.
 * `ctx.authorized` is the gate's decision, and a tool whose action does not
 * match it is refused no matter how legal the stage makes it look.
 *
 * The practical consequence: the model cannot obtain the words for a probe it
 * was not told to ask. It has nothing to read out, so silence is not a rule it
 * is asked to follow — it is the only thing available to it.
 *
 * ── Reading is gated too, and for a different reason ───────────────────────
 *
 * `get_interview_context` returns the oral brief only during
 * ORAL_PROBLEM_DELIVERY. Not because reading it later would be unsafe, but
 * because a model holding the full brief will paraphrase it into an answer at
 * some point in the next forty minutes, and invariant 2 says the problem
 * statement is delivered once, orally, from authored text. Nothing else here
 * ever returns facts wholesale, hidden tests, or solution families.
 */

export const VOICE_TOOLS = [
  "get_interview_context",
  "get_clarification_fact",
  "get_probe_wording",
  "get_follow_up",
  "record_delivery",
] as const;

export type VoiceToolName = (typeof VOICE_TOOLS)[number];

const TOOL_SET = new Set<string>(VOICE_TOOLS);

/**
 * The action each speaking tool is the mouth of.
 *
 * `get_interview_context` and `record_delivery` are absent deliberately: one
 * reads non-speech state, the other records that speech already happened. A
 * tool that maps to an action must be authorized for it.
 */
const TOOL_ACTION: Partial<Record<VoiceToolName, InterviewAction>> = {
  get_clarification_fact: "ANSWER_CLARIFICATION",
  get_probe_wording: "ASK_PROBE",
  get_follow_up: "PRESENT_FOLLOW_UP",
};

export type ToolRefusal =
  | "UNKNOWN_TOOL"
  | "INVALID_ARGS"
  | "STAGE_FORBIDS"
  | "NOT_AUTHORIZED"
  | "NOT_ANSWERABLE"
  | "NO_SUCH_ITEM";

export type ToolResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; refusal: ToolRefusal; reason: string };

const refuse = (refusal: ToolRefusal, reason: string): ToolResult => ({ ok: false, refusal, reason });

export interface VoiceToolContext {
  scenario: InterviewScenarioVersion;
  state: InterviewState;
  remainingSeconds: number;
  candidateState: CandidateState;
  probeUseCounts: Readonly<Record<string, number>>;
  /** Fact keys already answered, so the agent knows what it has said. */
  answeredFactKeys: readonly string[];
  /**
   * What the Response Gate authorized for the current turn, or null.
   *
   * Null means the interviewer has not been given the floor, and every speaking
   * tool refuses. This is the field that keeps the gate authoritative.
   */
  authorized: GateDecision | null;
}

export interface VoiceToolDeps {
  /** Records that something was actually delivered. The only write path. */
  recordDelivery(entry: {
    kind: string;
    ref?: string | undefined;
    transcript?: string | undefined;
  }): Promise<void>;
}

export async function executeVoiceTool(
  request: { name: string; args?: Record<string, unknown> },
  ctx: VoiceToolContext,
  deps: VoiceToolDeps,
): Promise<ToolResult> {
  const { name } = request;
  const args = request.args ?? {};

  // No arbitrary data access. A name outside the five is not a capability the
  // model has, whatever it thinks it is calling.
  if (!TOOL_SET.has(name)) {
    return refuse("UNKNOWN_TOOL", `"${name}" is not one of the ${VOICE_TOOLS.length} voice tools`);
  }

  const tool = name as VoiceToolName;
  const action = TOOL_ACTION[tool];

  if (action) {
    if (!isActionAllowed(ctx.state, action)) {
      return refuse("STAGE_FORBIDS", `${action} is not permitted in ${ctx.state}`);
    }
    // The gate, not the stage and not the model.
    if (ctx.authorized?.action !== action) {
      return refuse(
        "NOT_AUTHORIZED",
        `the gate authorized ${ctx.authorized?.action ?? "nothing"}, not ${action}`,
      );
    }
  }

  switch (tool) {
    case "get_interview_context":
      return interviewContext(ctx);
    case "get_clarification_fact":
      return clarificationFact(args, ctx);
    case "get_probe_wording":
      return probeWording(ctx);
    case "get_follow_up":
      return followUp(ctx);
    case "record_delivery":
      return recordDelivery(args, deps);
  }
}

/**
 * Non-secret situational awareness.
 *
 * Everything here is something the candidate already knows or could infer from
 * the clock. Note what is missing: facts, hidden tests, solution families,
 * probes, the hint ladder, and any assessment of how the candidate is doing.
 */
function interviewContext(ctx: VoiceToolContext): ToolResult {
  const data: Record<string, unknown> = {
    stage: ctx.state,
    remainingSeconds: ctx.remainingSeconds,
    hintsUsed: ctx.candidateState.hintsUsed.length,
    probesAsked: ctx.candidateState.probeHistory.length,
    factsAlreadyAnswered: [...ctx.answeredFactKeys],
    authorizedAction: ctx.authorized?.action ?? "STAY_SILENT",
  };

  // The brief, only while delivering it. Held to the authored text and the
  // reviewed repeat variants — the agent picks among them, it does not compose.
  if (ctx.state === "ORAL_PROBLEM_DELIVERY") {
    data["openingScript"] = ctx.scenario.oralBrief.openingScript;
    data["repeatVariants"] = [...ctx.scenario.oralBrief.repeatVariants];
  }

  return { ok: true, data };
}

/**
 * A canonical fact, or an explicit refusal.
 *
 * There is no branch in which a value is composed (invariant 3). The utterance
 * is matched against authored `askedAs` phrasings and either resolves to a fact
 * the disclosure policy permits, or does not.
 */
function clarificationFact(args: Record<string, unknown>, ctx: VoiceToolContext): ToolResult {
  const utterance = typeof args["utterance"] === "string" ? args["utterance"] : null;
  if (!utterance) return refuse("INVALID_ARGS", "utterance is required and must be a string");

  const result = getClarificationFact({
    scenario: ctx.scenario,
    utterance,
    state: ctx.state,
    probeHistory: ctx.candidateState.probeHistory,
  });

  if (!result.answerable) {
    // The agent says it cannot answer. It does not guess, and it is not handed
    // a nearby fact to improvise from.
    return refuse("NOT_ANSWERABLE", result.reason);
  }

  return { ok: true, data: { factKey: result.factKey, value: result.value } };
}

/**
 * Wording for the probe the gate chose.
 *
 * The probe id comes from `ctx.authorized`, never from the model's arguments.
 * Accepting an id would let it browse the probe list one call at a time, and the
 * whole point of authored probes is that the interviewer asks the question the
 * author decided was worth asking at this moment.
 */
function probeWording(ctx: VoiceToolContext): ToolResult {
  const probeId = ctx.authorized?.probeId;
  if (!probeId) return refuse("NOT_AUTHORIZED", "no probe was authorized for this turn");

  const probe = ctx.scenario.probes.find((p) => p.id === probeId);
  if (!probe) return refuse("NO_SUCH_ITEM", `probe "${probeId}" is not in this scenario version`);

  return {
    ok: true,
    data: {
      probeId: probe.id,
      wording: selectProbeWording(probe, ctx.probeUseCounts[probe.id] ?? 0),
      intent: probe.questionIntent,
    },
  };
}

/** Same rule as probes: the branch is the gate's choice, not the model's. */
function followUp(ctx: VoiceToolContext): ToolResult {
  const followUpId = ctx.authorized?.followUpId;
  if (!followUpId) return refuse("NOT_AUTHORIZED", "no follow-up was authorized for this turn");

  const branch = ctx.scenario.followUps.find((f) => f.id === followUpId);
  if (!branch) {
    return refuse("NO_SUCH_ITEM", `follow-up "${followUpId}" is not in this scenario version`);
  }

  return { ok: true, data: { followUpId: branch.id, oralDelta: branch.oralDelta } };
}

/**
 * Report what was actually said.
 *
 * The only tool that writes. It records rather than decides — an agent that
 * calls this without having been authorized has still not spoken legitimately,
 * and the mismatch between recorded deliveries and gate decisions is exactly
 * what M4-5b reads back off a session.
 */
async function recordDelivery(
  args: Record<string, unknown>,
  deps: VoiceToolDeps,
): Promise<ToolResult> {
  const kind = typeof args["kind"] === "string" ? args["kind"] : null;
  if (!kind) return refuse("INVALID_ARGS", "kind is required and must be a string");

  await deps.recordDelivery({
    kind,
    ref: typeof args["ref"] === "string" ? args["ref"] : undefined,
    transcript: typeof args["transcript"] === "string" ? args["transcript"] : undefined,
  });

  return { ok: true, data: { recorded: true } };
}
