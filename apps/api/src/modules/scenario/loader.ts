import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type InterviewScenarioVersion,
  InterviewScenarioVersionSchema,
} from "@master-leeter/contracts";
import { parse as parseYaml } from "yaml";

/**
 * Scenario loader (M1-1).
 *
 * Scenarios are files under `content/scenarios/<scenarioId>/v<n>.yaml`, reviewed
 * by pull request. There is no authoring UI in the MVP (docs/MVP.md).
 *
 * Two rules this module enforces, both load-bearing:
 *
 *   1. A version is IMMUTABLE. We hash the file contents at load and expose the
 *      digest, so a session that pinned a version can prove the content it ran
 *      against has not changed underneath it (invariant 4).
 *   2. Provenance is mandatory. A scenario without an author and source type
 *      fails to load — hiding the problem text is a UX decision, not legal
 *      clearance.
 */

export class ScenarioLoadError extends Error {
  constructor(
    readonly path: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`${path}: ${message}`);
    this.name = "ScenarioLoadError";
  }
}

export interface LoadedScenario {
  version: InterviewScenarioVersion;
  /** sha256 of the raw file bytes. Pin this alongside the version id. */
  contentHash: string;
  sourcePath: string;
}

export function hashContent(raw: string): string {
  return `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
}

export function parseScenario(raw: string, sourcePath: string): LoadedScenario {
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new ScenarioLoadError(sourcePath, "not valid YAML", err);
  }

  const result = InterviewScenarioVersionSchema.safeParse(doc);
  if (!result.success) {
    // Zod's default message is unreadable at this size. Scenario authors are
    // writers as much as engineers — the error has to say which field and why.
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ScenarioLoadError(sourcePath, `failed validation\n${issues}`);
  }

  const version = result.data;
  assertInternallyConsistent(version, sourcePath);

  return { version, contentHash: hashContent(raw), sourcePath };
}

/**
 * Checks the schema cannot express.
 *
 * These are the mistakes a well-meaning author actually makes, and every one of
 * them would surface at runtime as either a crash or — worse — a silently
 * degraded interview.
 */
function assertInternallyConsistent(v: InterviewScenarioVersion, path: string): void {
  const problems: string[] = [];

  if (v.id !== `${v.scenarioId}@${v.version}`) {
    problems.push(`id must be "${v.scenarioId}@${v.version}", got "${v.id}"`);
  }

  const factKeys = new Set<string>();
  for (const f of v.facts) {
    if (factKeys.has(f.key)) problems.push(`duplicate fact key "${f.key}"`);
    factKeys.add(f.key);
  }

  const probeIds = new Set<string>();
  for (const p of v.probes) {
    if (probeIds.has(p.id)) problems.push(`duplicate probe id "${p.id}"`);
    probeIds.add(p.id);
  }

  const familyIds = new Set(v.solutionFamilies.map((f) => f.id));
  if (familyIds.size !== v.solutionFamilies.length) {
    problems.push("duplicate solution family ids");
  }
  if (!v.solutionFamilies.some((f) => f.isOptimal)) {
    // Without a marked optimal family there is nothing to compare a complexity
    // claim against, so the complexity probe can never fire.
    problems.push("at least one solution family must be marked isOptimal");
  }

  const levels = v.hintLadder.map((h) => h.level).sort((a, b) => a - b);
  if (levels.join(",") !== "1,2,3,4") {
    problems.push(`hint ladder must contain levels 1-4 exactly once, got ${levels.join(",")}`);
  }
  for (let i = 1; i < v.hintLadder.length; i++) {
    const prev = v.hintLadder[i - 1];
    const curr = v.hintLadder[i];
    if (prev && curr && curr.scoreImpact < prev.scoreImpact) {
      problems.push("hint score impact must not decrease as levels escalate");
      break;
    }
  }

  // A hidden test that isn't marked hidden would be shown to the candidate.
  for (const t of v.hiddenTests) {
    if (!t.hidden) problems.push(`hidden test "${t.id}" is not marked hidden:true`);
  }
  for (const t of v.visibleStarterTests) {
    if (t.hidden) problems.push(`starter test "${t.id}" is marked hidden:true`);
  }

  if (v.status === "ACTIVE" && v.provenance.reviewNotes.trim().length === 0) {
    problems.push("an ACTIVE scenario requires non-empty provenance review notes");
  }

  if (problems.length > 0) {
    throw new ScenarioLoadError(path, `internal consistency:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

export async function loadScenarioFile(path: string): Promise<LoadedScenario> {
  const raw = await readFile(path, "utf8");
  return parseScenario(raw, path);
}

/**
 * Loads every scenario version under a content root.
 *
 * Retired and draft versions are loaded too — a session that pinned a retired
 * version must still be replayable (invariant 4). Filter by status at selection
 * time, not at load time.
 */
export async function loadScenarioLibrary(contentRoot: string): Promise<Map<string, LoadedScenario>> {
  const library = new Map<string, LoadedScenario>();
  const dirs = await readdir(contentRoot, { withFileTypes: true });

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const scenarioDir = join(contentRoot, dir.name);
    const files = await readdir(scenarioDir);

    for (const file of files) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const loaded = await loadScenarioFile(join(scenarioDir, file));

      if (library.has(loaded.version.id)) {
        throw new ScenarioLoadError(loaded.sourcePath, `duplicate scenario version id "${loaded.version.id}"`);
      }
      library.set(loaded.version.id, loaded);
    }
  }

  return library;
}

/** Only ACTIVE versions may start new sessions. Existing sessions keep their pin. */
export function selectableScenarios(library: Map<string, LoadedScenario>): LoadedScenario[] {
  return [...library.values()].filter((s) => s.version.status === "ACTIVE");
}

/**
 * Opaque public handle for a scenario version.
 *
 * Scenario ids are descriptive by design — `conveyor-rescan@1` tells an author
 * exactly what they're editing. But the id would otherwise reach the browser in
 * the setup catalogue, and "conveyor rescan" gives away the framing of a problem
 * the candidate is supposed to hear for the first time, out loud. Descriptive
 * internally, opaque externally.
 */
export function scenarioRef(versionId: string): string {
  return `scn_${createHash("sha256").update(versionId, "utf8").digest("hex").slice(0, 16)}`;
}

/** Resolves a public ref, or an internal id, back to a loaded scenario. */
export function resolveScenario(
  library: Map<string, LoadedScenario>,
  refOrId: string,
): LoadedScenario | null {
  const direct = library.get(refOrId);
  if (direct) return direct;

  for (const scenario of library.values()) {
    if (scenarioRef(scenario.version.id) === refOrId) return scenario;
  }
  return null;
}
