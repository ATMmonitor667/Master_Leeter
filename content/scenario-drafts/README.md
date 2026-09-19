# Question library awaiting review

Seven original drafts extend the five existing scenarios to twelve question
families. These are outside the runtime catalogue and remain `DRAFT`. Neither
the API image nor the default import command serves them. No completed human
or similarity review is claimed.

| Draft | Primary topic | Reference function |
|---|---|---|
| sensor-balance | Prefix sums and hashing | calibration_block |
| cooling-watch | Monotonic stack | cooling_wait |
| courier-grid | Breadth-first search | fewest_moves |
| batch-prerequisites | Topological ordering and heaps | job_order |
| packing-capacity | Binary search with greedy feasibility | minimum_capacity |
| archive-stitch | Dynamic programming | minimum_labels |
| service-windows | Sorting and interval union | merge_windows |

Each directory contains an oral brief, explicit function contract, examples,
private edge cases, solution-family invariants, authored probes, four graduated
hints, one follow-up and an author-owned Python reference. Case input is a JSON
array of positional function arguments; output is a JSON value. These references
are content-authoring material, not a candidate execution service. The free beta
continues to label correctness scores as model estimates.

Validate all draft schemas without any network or writes:

```text
pnpm questions:import --drafts
```

`--drafts --apply` optionally inserts only DRAFT records into the private bank;
it never activates a question. Keep the default five-family import unchanged.

For each draft, the reviewer checks contract/edge cases and reference correctness,
complexity bounds, similarity to third-party wording, disclosure levels, hint
escalation and an oral dry run. Record reviewer and date before publication.
If a draft version has already been imported, publish revisions under a new
version ID: the importer will refuse to overwrite its immutable content hash.
Move only reviewed release content into `content/scenarios` and record activation
as an explicit operator action. Update any catalogue-count acceptance expectation
when the active library changes.
