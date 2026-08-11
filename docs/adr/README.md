# Architecture Decision Records

Decisions inherited from the system design report. Each is presumed binding — reversing one
requires a new ADR that supersedes it, not a quiet code change.

| ID | Decision | Rationale |
|---|---|---|
| ADR-001 | Application-controlled response creation | Turn detection ≠ permission to speak. **Verified M0-1 (2026-08-11):** Gemini Live, p50 1044 ms / p95 1638 ms. See [ADR-001](ADR-001-response-control.md). |
| ADR-002 | Scenario graph over freeform question generation | Consistency, legal provenance, quality, reproducible evaluation |
| ADR-003 | Append-only session evidence | Auditability, replay, grader improvement, support debugging |
| ADR-004 | Separate live interviewer and evaluator | Conflicting objectives and latency profiles; avoids self-grading bias |
| ADR-005 | Modular monolith for MVP | Reduces operational complexity while preserving service boundaries |
| ADR-006 | External sandbox (Judge0) first | Code isolation is hard; buy time to focus on interaction quality |
| ADR-007 | No raw audio retention by default | Privacy and trust; transcript is usually sufficient for scoring |

## Open decisions to record as you make them

- ~~Realtime voice provider and model, with the latency numbers that justified it (M0-1)~~ → **Gemini Live `gemini-2.5-flash-native-audio-latest`; see ADR-001**
- Judge0 self-hosted vs managed, and the isolation configuration (M0-2)
- Code-state freshness threshold `N` — the maximum age of a revision an interviewer response
  may reference (M5-3)
- `END_THRESHOLD` for semantic turn completion, and the human-review data behind it (M4-2)
- Scenario content format: YAML vs JSON, and the review workflow (M1-1)
