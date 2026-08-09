/**
 * @master-leeter/contracts — the seam between all three lanes.
 *
 * Lane A builds against a fake client, Lane B against a fake orchestrator, and
 * Lane C against recorded event streams. That only works while these types stay
 * stable, so treat changes here as requiring agreement across lanes.
 *
 * See ./README.md for the ordering, idempotency, and trace-ID rules.
 */
export * from "./interview-state.js";
export * from "./session-event.js";
export * from "./scenario.js";
export * from "./candidate-state.js";
export * from "./gate.js";
