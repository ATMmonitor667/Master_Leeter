import type { FastifyInstance } from "fastify";
import { type LoadedScenario, scenarioRef, selectableScenarios } from "./loader.js";
import { type QuestionBank, QuestionBankError } from "./question-bank.js";

/**
 * Scenario module — content loading, versioning, and the clarification map.
 *
 * Scenarios are files in `content/scenarios/`, reviewed by pull request (no CMS
 * in the MVP). Versions are immutable: retire, never edit (invariant 4).
 *
 * The clarification tool returns a canonical fact or NOT_ANSWERABLE. There is no
 * code path in which the model supplies a fact the scenario does not contain.
 */

export {
  loadScenarioFile,
  loadScenarioLibrary,
  parseScenario,
  resolveScenario,
  scenarioRef,
  selectableScenarios,
} from "./loader.js";
export { getClarificationFact, matchFactKey } from "./clarification.js";
export {
  eligibleProbes,
  highestPriorityEligibleProbe,
  nextAllowedHintLevel,
  rerankEligibleProbes,
  selectRelevantProbe,
  selectFollowUp,
} from "./probes.js";
export { evaluateTrigger, validateScenarioTriggers } from "./triggers.js";

export interface ScenarioModuleOptions {
  library: Map<string, LoadedScenario>;
  questionBank?: QuestionBank;
}

export async function registerScenarioModule(
  app: FastifyInstance,
  opts: ScenarioModuleOptions,
): Promise<void> {
  /**
   * Catalogue for the session-setup screen.
   *
   * Returns only what a candidate may see before starting: topic, level, and
   * duration. No oral brief, no facts, no probes, no tests. Everything the
   * interview is *about* stays server-side until the voice agent delivers it.
   */
  app.get("/scenarios", async (_req, reply) => {
    let questions: LoadedScenario[];
    try {
      questions = opts.questionBank ? await opts.questionBank.listActive() : selectableScenarios(opts.library);
    } catch (error) {
      if (!(error instanceof QuestionBankError)) throw error;
      return reply.code(503).send({ error: "QUESTION_BANK_UNAVAILABLE", message: "Interview questions are temporarily unavailable. Please retry shortly." });
    }
    const catalogue = questions.map((s) => ({
      // Opaque ref, not the descriptive id — the id names the problem.
      ref: scenarioRef(s.version.id),
      level: s.version.target.level,
      topics: s.version.target.topics,
      expectedMinutes: s.version.target.expectedMinutes,
    }));
    return reply.send({ scenarios: catalogue });
  });
}
