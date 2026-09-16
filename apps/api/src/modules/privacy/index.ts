import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userIdFor } from "../auth/index.js";
import type { EvaluationQueue } from "../report/index.js";
import type { EventLog } from "../session/event-log.js";
import type { SessionStore } from "../session/session-store.js";
import type { PreparationStore } from "../preparation/store.js";
import {
  CURRENT_NOTICE_VERSION,
  ConsentScopeSchema,
  isPermitted,
} from "./consent.js";
import { InMemoryConsentStore, type ConsentStore } from "./consent-store.js";
import { type Deletable, type DeletionRequest, executeDeletion } from "./deletion.js";

export {
  CONSENT_SCOPES,
  CURRENT_NOTICE_VERSION,
  RETENTION_DAYS,
  emptyConsent,
  isExpired,
  isPermitted,
  latestGrant,
  record,
  scopesToPurge,
  type ConsentGrant,
  type ConsentScope,
  type ConsentState,
} from "./consent.js";
export { InMemoryConsentStore, type ConsentStore } from "./consent-store.js";
export {
  REDACTED,
  executeDeletion,
  redactEvent,
  redactionFor,
  type Deletable,
  type DeletionReceipt,
  type DeletionRequest,
} from "./deletion.js";

/**
 * Privacy module (M7-3).
 *
 * Consent, retention, deletion and export. Kept as its own module rather than
 * folded into the session module because these operations cut across every
 * store, and a privacy guarantee scattered across four files is a privacy
 * guarantee nobody can audit.
 */

const ConsentBody = z.object({
  scope: ConsentScopeSchema,
  granted: z.boolean(),
});

/** Reports are derived data — deletable without touching the source events. */
export class ReportStore implements Deletable {
  readonly name = "reports";
  constructor(private readonly queue: { forget?(sessionId: string): boolean | Promise<boolean> }) {}

  async deleteForSession(sessionId: string): Promise<number> {
    return (await this.queue.forget?.(sessionId)) ? 1 : 0;
  }
  async deleteForUser(): Promise<number> {
    return 0;
  }
}

/**
 * Audio store.
 *
 * Present and empty on purpose. Raw audio is not retained by default
 * (invariant 10), so this deletes nothing today — but a deletion path that
 * appears the moment audio does is a path someone forgets to write.
 */
export class AudioStore implements Deletable {
  readonly name = "audio";
  async deleteForSession(): Promise<number> {
    return 0;
  }
  async deleteForUser(): Promise<number> {
    return 0;
  }
}

export interface PrivacyModuleOptions {
  eventLog: EventLog;
  sessions: SessionStore;
  evaluationQueue?: EvaluationQueue;
  consentStore?: ConsentStore;
  preparationStore?: PreparationStore;
}

export async function registerPrivacyModule(
  app: FastifyInstance,
  opts: PrivacyModuleOptions,
): Promise<void> {
  const consents = opts.consentStore ?? new InMemoryConsentStore();

  const stores: Deletable[] = [
    new ReportStore(opts.evaluationQueue ?? {}),
    new AudioStore(),
    ...(opts.preparationStore ? [{
      name: "preparations",
      deleteForSession: (sessionId: string) => opts.preparationStore!.deleteForSession(sessionId),
      deleteForUser: (userId: string) => opts.preparationStore!.deleteForUser(userId),
    }] : []),
  ];

  const principal = userIdFor;

  app.get("/privacy/consent", async (req, reply) => {
    const userId = principal(req);
    const state = await consents.get(userId);

    return reply.send({
      noticeVersion: CURRENT_NOTICE_VERSION,
      // Reported per scope so the UI shows what is actually on, and defaults
      // read as off rather than absent.
      transcript: isPermitted(state, "TRANSCRIPT"),
      rawAudio: isPermitted(state, "RAW_AUDIO"),
      calibration: isPermitted(state, "CALIBRATION"),
    });
  });

  app.post("/privacy/consent", async (req, reply) => {
    const body = ConsentBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "INVALID_BODY", detail: body.error.issues });
    }

    const userId = principal(req);
    const updated = await consents.record(userId, {
      scope: body.data.scope,
      granted: body.data.granted,
      decidedAt: new Date().toISOString(),
      noticeVersion: CURRENT_NOTICE_VERSION,
    });
    return reply.send({ scope: body.data.scope, granted: isPermitted(updated, body.data.scope) });
  });

  app.delete("/privacy/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = principal(req);

    const session = await opts.sessions.get(id);
    if (!session) return reply.code(404).send({ error: "UNKNOWN_SESSION" });

    // M2-8 fills this in properly. Until then the check is honest about being
    // a placeholder rather than pretending to be authorization.
    if (session.userId !== userId) {
      return reply.code(403).send({ error: "NOT_YOURS" });
    }

    const request: DeletionRequest = {
      // Active deletion is refused until finalization drains live observations.
      scope: "SESSION",
      userId,
      sessionId: id,
      requestedAt: new Date().toISOString(),
    };

    if (!session.endedAt) return reply.code(409).send({ error: "END_SESSION_BEFORE_DELETION" });

    await opts.sessions.tombstone(id, request.requestedAt);

    const receipt = await executeDeletion(request, {
      eventLog: opts.eventLog,
      sessionsOf: async () => [id],
      stores,
    });

    // 200 with a receipt, not 204. The user should be able to see what was
    // reached and what was not.
    return reply.send(receipt);
  });

  app.delete("/privacy/account", async (req, reply) => {
    const userId = principal(req);
    const sessionIds = (await opts.sessions.idsForUser?.(userId)) ?? [];
    for (const id of sessionIds) {
      if (!(await opts.sessions.get(id))?.endedAt) return reply.code(409).send({ error: "END_SESSION_BEFORE_DELETION" });
    }
    const requestedAt = new Date().toISOString();
    for (const id of sessionIds) await opts.sessions.tombstone(id, requestedAt);

    const receipt = await executeDeletion(
      { scope: "ACCOUNT", userId, requestedAt },
      { eventLog: opts.eventLog, sessionsOf: async () => sessionIds, stores },
    );

    await consents.deleteForUser(userId);
    return reply.send(receipt);
  });

  /**
   * Data export.
   *
   * The counterpart to deletion: a user who cannot see what is held about them
   * cannot make a meaningful decision about deleting it.
   */
  app.get("/privacy/sessions/:id/export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = principal(req);

    const session = await opts.sessions.get(id);
    if (!session) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    if (session.userId !== userId) return reply.code(403).send({ error: "NOT_YOURS" });

    const events = await opts.eventLog.read(id);

    return reply.send({
      session: {
        id: session.id,
        createdAt: session.createdAt,
        endedAt: session.endedAt,
        mode: session.mode,
        language: session.language,
      },
      // Scenario content is excluded. It is the product's content, not the
      // user's data, and exporting it would hand over the problem set.
      events: events.map((e) => ({
        seq: e.seq,
        occurredAt: e.occurredAt,
        type: e.type,
        actor: e.actor,
        payload: e.actor === "CANDIDATE" ? e.payload : {},
      })),
    });
  });
}
