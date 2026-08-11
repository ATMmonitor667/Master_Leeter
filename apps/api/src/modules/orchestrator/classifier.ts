import type { TurnIntent } from "@master-leeter/contracts";

/**
 * Turn / intent classifier — deterministic stub (M4-1 placeholder).
 *
 * The real classifier is a small fast model. This is not it, and it does not
 * pretend to be: it is a rules-only implementation that exists so the Response
 * Gate can run in the live path *now*, against a real interface, instead of
 * waiting for a provider decision.
 *
 * Three properties make it a legitimate placeholder rather than a lie:
 *
 *   1. It satisfies the same interface the model will. Swapping it out is a
 *      constructor argument, not a refactor.
 *   2. It is deterministic, so replay stays total (see `replay.test.ts` — every
 *      decision must be reproducible from the log).
 *   3. It is biased toward silence. Where it is unsure of turn completion it
 *      returns a LOW end probability, which the gate reads as "wait". A stub
 *      that guessed high would manufacture interruptions and make the
 *      unwanted-interruption metric meaningless before it is even measured.
 *
 * What it is bad at, stated plainly: `semanticEndProbability` on unpunctuated
 * speech. Real transcripts arrive without reliable punctuation, and deciding
 * whether "so I think I'd use a hash map" is a finished thought needs semantics
 * this cannot supply. That gap is exactly M4-2, and until it closes this stub
 * will under-respond rather than over-respond.
 */

export interface TurnClassification {
  intent: TurnIntent;
  intentProbabilities: Record<string, number>;
  semanticEndProbability: number;
  /**
   * Which classifier produced this. Persisted with the decision so a session
   * audited months later says whether a stub or a model made the call.
   */
  classifierId: string;
}

export interface ClassifierInput {
  transcript: string;
  /** True when the transport says the utterance is complete, not mid-stream. */
  finalized: boolean;
}

export interface IntentClassifier {
  /**
   * Stable identity, recorded on every ACTION_DECIDED event.
   *
   * Both implementations already carried this; the interface simply failed to
   * declare it, which meant a caller holding an `IntentClassifier` could not
   * ask which one it had. That matters at exactly two moments: the boot log,
   * and reading back a session to find out whether it ran on the model or
   * degraded to the stub halfway through.
   */
  readonly id: string;

  /**
   * Sync or async, and callers must `await` regardless.
   *
   * The union is load-bearing rather than lazy typing. A model-backed
   * classifier is necessarily async, but `RuleBasedClassifier` must stay
   * synchronous: it is the fallback the model path degrades to, and a fallback
   * that costs a microtask on the critical path is a worse fallback. Widening
   * the interface lets both be first-class without wrapping the cheap one in a
   * promise it never needed.
   */
  classify(input: ClassifierInput): TurnClassification | Promise<TurnClassification>;
}

/**
 * Ordered intent rules. First match wins, so the order IS the precedence.
 *
 * Hint requests sit above questions on purpose: "can you give me a hint?" is
 * both, and treating it as a clarification would hand the candidate a fact from
 * the scenario instead of spending a hint from their budget.
 */
const INTENT_RULES: ReadonlyArray<{ intent: TurnIntent; pattern: RegExp }> = [
  {
    intent: "HINT_REQUEST",
    pattern: /\b(hint|nudge|point me|help me out|give me a clue|i'?m stuck|any suggestions?)\b/i,
  },
  {
    intent: "COMPLEXITY_CLAIM",
    pattern:
      /\b(o\s*\(|big[- ]?o|linear time|constant (time|space)|quadratic|logarithmic|n log n|amortized)\b/i,
  },
  {
    intent: "DONE_SIGNAL",
    pattern:
      /\b(i think that'?s it|that should (work|do it)|i'?m done|that'?s my solution|finished|ready for)\b/i,
  },
  {
    intent: "TEST_PLAN",
    pattern: /\b(let me test|i'?ll test|edge case|test (it |this )?with|try it with|what if the input)\b/i,
  },
  {
    intent: "CONFUSION",
    pattern: /\b(i'?m not sure|i'?m confused|no idea|i don'?t (know|follow|understand)|lost me)\b/i,
  },
  {
    intent: "SOCIAL_SMALL_TALK",
    pattern: /\b(how are you|nice to meet|good morning|thanks(!| a lot)?$|sorry about|can you hear me)\b/i,
  },
  {
    intent: "APPROACH_COMMITMENT",
    pattern: /\b(i'?ll use|i'?m going to use|let'?s go with|my approach (is|will be)|i'?ll implement)\b/i,
  },
];

/**
 * Vocabulary that distinguishes "asking about the problem" from "asking me
 * anything". Only the former should reach the clarification map.
 */
const CLARIFICATION_VOCAB =
  /\b(input|inputs|duplicates?|sorted|order(ing|ed)?|empty|null|none|negative|range|bounds?|size|length|constraints?|assume|guaranteed|mutate|in[- ]?place|return|tie|ties|case[- ]?sensitive|unicode|overflow)\b/i;

const INTERROGATIVE_OPENER =
  /^\s*(can|could|should|would|will|is|are|am|do|does|did|what|how|why|when|where|which|if|any)\b/i;

/**
 * Words that mean the speaker is still going, whatever the pause suggests.
 *
 * This list is the single most load-bearing thing in the file. A candidate who
 * trails off with "so..." and gets answered has been interrupted, and that is
 * the failure the product exists to avoid.
 */
const TRAILING_CONTINUATION =
  /\b(so|and|but|or|because|then|which|that|if|when|the|a|an|to|of|for|with|maybe|like|um|uh|erm|actually|basically|i|we|it)\s*$/i;

/**
 * Does this transcript end mid-thought?
 *
 * Exported because the model classifier applies it as a hard veto over whatever
 * the model returns (see `gemini-classifier.ts`). Keeping one definition means
 * the rule cannot drift between the two implementations and quietly stop
 * protecting the trailing-off case in the path that actually ships.
 */
export function endsMidThought(transcript: string): boolean {
  return TRAILING_CONTINUATION.test(transcript.trim());
}

/** Ceiling applied to a model's end-probability when the veto fires. */
export const MID_THOUGHT_CEILING = 0.2;

export class RuleBasedClassifier implements IntentClassifier {
  readonly id = "stub-rules-v1";

  classify(input: ClassifierInput): TurnClassification {
    const transcript = input.transcript.trim();
    const intent = this.intentOf(transcript);

    return {
      intent,
      // A rule fired or it didn't. Expressing that as a calibrated-looking
      // distribution would invite downstream code to threshold on a number
      // this classifier cannot actually justify.
      intentProbabilities: { [intent]: 1 },
      semanticEndProbability: this.endProbability(transcript, input.finalized),
      classifierId: this.id,
    };
  }

  private intentOf(transcript: string): TurnIntent {
    if (transcript.length === 0) return "THINK_ALOUD";

    for (const rule of INTENT_RULES) {
      if (rule.pattern.test(transcript)) return rule.intent;
    }

    const looksLikeQuestion = transcript.endsWith("?") || INTERROGATIVE_OPENER.test(transcript);
    if (looksLikeQuestion) {
      return CLARIFICATION_VOCAB.test(transcript) ? "CLARIFICATION_REQUEST" : "EXPLICIT_QUESTION";
    }

    // The default, and by volume the overwhelmingly common case. Someone
    // reasoning out loud is the normal state of a good interview.
    return "THINK_ALOUD";
  }

  /**
   * Confidence that the candidate actually finished their thought.
   *
   * Deliberately conservative. The only case this is confident about is an
   * explicit question mark — everything else leans low enough that MOCK's 0.8
   * threshold keeps the interviewer quiet. Under-responding is a bug we can
   * measure and fix; interrupting someone mid-sentence is the thing users
   * remember.
   */
  private endProbability(transcript: string, finalized: boolean): number {
    // The transport itself says this is still streaming. Nothing else matters.
    if (!finalized) return 0;
    if (transcript.length === 0) return 0;

    if (TRAILING_CONTINUATION.test(transcript)) return 0.2;
    if (transcript.endsWith("?")) return 0.95;
    if (/[.!]$/.test(transcript)) return 0.85;

    // Unpunctuated and not obviously trailing. This is the honest middle, and
    // it sits below every mode's threshold — which means the stub stays silent
    // and M4-2 has a visible, measurable gap to close rather than a hidden one.
    return 0.55;
  }
}

/** Default instance. Stateless, so sharing one across sessions is safe. */
export const ruleBasedClassifier = new RuleBasedClassifier();
