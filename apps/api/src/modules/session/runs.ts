import { randomUUID } from "node:crypto";
import type { ServerMessage, SessionEvent } from "@master-leeter/contracts";
import type { InterviewRuntime } from "../orchestrator/runtime.js";
import { DEFAULT_LIMITS, type RunQueue } from "../runner/index.js";
import type { InterviewSession, SessionStore } from "./session-store.js";

/**
 * Run execution triggered from the session event log.
 *
 * The client requests runs over the app WebSocket as RUN_REQUESTED events.
 * The channel persists them first; this module enqueues execution and pushes
 * RUN_RESULT (or an ERROR) back to any connected socket.
 */

export interface RunContext {
  sessionId: string;
  scenarioVersionId: string;
  traceId: string;
}

export interface RunCoordinatorDeps {
  queue: RunQueue | null;
  store: SessionStore;
  runtimeFor: (sessionId: string) => Promise<InterviewRuntime | null>;
  runContext: Map<string, RunContext>;
  pushToSession: (sessionId: string, msg: ServerMessage) => void;
}

function numberOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function stringOf(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function enqueueRun(
  session: InterviewSession,
  params: { source: string; revision: number; input: string },
  deps: RunCoordinatorDeps,
): { runId: string } | null {
  if (!deps.queue) {
    deps.pushToSession(session.id, {
      kind: "ERROR",
      code: "RUNNER_UNAVAILABLE",
      message: "Execution is temporarily unavailable. Keep going.",
    });
    return null;
  }

  const runId = randomUUID();
  deps.runContext.set(runId, {
    sessionId: session.id,
    scenarioVersionId: session.scenarioVersionId,
    traceId: session.traceId,
  });

  const accepted = deps.queue.enqueue({
    runId,
    sessionId: session.id,
    language: session.language,
    source: params.source,
    codeRevision: params.revision,
    stdin: params.input,
    limits: DEFAULT_LIMITS,
  });

  if (!accepted) {
    deps.runContext.delete(runId);
    deps.pushToSession(session.id, {
      kind: "ERROR",
      code: "RUNNER_BUSY",
      message: "Too many runs queued.",
    });
    return null;
  }

  return { runId };
}

/** React to a persisted RUN_REQUESTED from the app channel. */
export async function handleRunRequestedEvent(
  event: SessionEvent,
  deps: RunCoordinatorDeps,
): Promise<void> {
  const session = await deps.store.get(event.sessionId);
  if (!session || session.endedAt) return;

  const revision = numberOf(event.payload["revision"]);
  const input = stringOf(event.payload["input"]) ?? "";
  if (revision === null) {
    deps.pushToSession(event.sessionId, {
      kind: "ERROR",
      code: "INVALID_RUN",
      message: "Run request is missing a code revision.",
    });
    return;
  }

  const runtime = await deps.runtimeFor(event.sessionId);
  if (!runtime) {
    deps.pushToSession(event.sessionId, {
      kind: "ERROR",
      code: "UNKNOWN_REVISION",
      message: "Code revision not found on server. Edit and try again.",
    });
    return;
  }

  const source = runtime.codeAtRevision(revision);
  if (source === null) {
    deps.pushToSession(event.sessionId, {
      kind: "ERROR",
      code: "UNKNOWN_REVISION",
      message: "Code revision not found on server. Edit and try again.",
    });
    return;
  }

  enqueueRun(session, { source, revision, input }, deps);
}
