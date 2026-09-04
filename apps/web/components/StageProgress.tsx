import type { InterviewState } from "@master-leeter/contracts";

const STAGES: Array<{ state: InterviewState; short: string; label: string }> = [
  { state: "ORAL_PROBLEM_DELIVERY", short: "Brief", label: "Problem brief" },
  { state: "CLARIFICATION", short: "Clarify", label: "Clarification" },
  { state: "APPROACH_EXPLORATION", short: "Approach", label: "Approach" },
  { state: "IMPLEMENTATION", short: "Code", label: "Implementation" },
  { state: "TEST_AND_DEBUG", short: "Test", label: "Test and debug" },
  { state: "FOLLOW_UP", short: "Extend", label: "Follow-up" },
  { state: "WRAP_UP", short: "Wrap", label: "Wrap-up" },
];

export const STAGE_LABELS: Record<InterviewState, string> = {
  ORAL_PROBLEM_DELIVERY: "Problem brief",
  CLARIFICATION: "Clarification",
  APPROACH_EXPLORATION: "Approach exploration",
  IMPLEMENTATION: "Implementation",
  TEST_AND_DEBUG: "Test and debug",
  FOLLOW_UP: "Follow-up",
  WRAP_UP: "Wrap-up",
  EVALUATION: "Evaluation",
};

export function StageProgress({ stage }: { stage: InterviewState }) {
  const active = STAGES.findIndex((item) => item.state === stage);

  return (
    <div className="stage-progress" aria-label={`Interview stage: ${STAGE_LABELS[stage]}`}>
      {STAGES.map((item, index) => (
        <div
          key={item.state}
          className={`stage-step${index === active ? " active" : ""}${index < active ? " complete" : ""}`}
          title={item.label}
        >
          <span className="stage-node" aria-hidden="true">{index < active ? "✓" : index + 1}</span>
          <span className="stage-copy">{item.short}</span>
        </div>
      ))}
    </div>
  );
}
