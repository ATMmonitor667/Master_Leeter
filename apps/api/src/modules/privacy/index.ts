import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EvaluationQueue } from "../report/index.js";
import type { EventLog } from "../session/event-log.js";
import type { SessionStore } from "../session/session-store.js";
import {
  CURRENT_NOTICE_VERSION,
  ConsentScopeSchema,
  type ConsentState,
  emptyConsent,
  isPermitted,
  record,
} from "./consent.js";
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
  constructor(private readonly queue: { forget?(sessionId: string): boolean }) {}

  async deleteForSession(sessionId: string): Promise<number> {
    return this.queue.forget?.(sessionId) ? 1 : 0;
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
  eventLog: EventLog & { redact?(sessionId: string): Promise<number> };
  sessions: SessionStore & { idsForUser?(userId: string): Promise<string[]> };
  evaluationQueue?: EvaluationQueue;
  consentStore?: Map<string, ConsentState>;
}

export async function registerPrivacyModule(
  app: FastifyInstance,
  opts: PrivacyModuleOptions,
): Promise<void> {
  const consents = opts.consentStore ?? new Map<string, ConsentState>();

  const stores: Deletable[] = [
    new ReportStore(opts.evaluationQueue ?? {}),
    new AudioStore(),
  ];

  // M2-8: replaced by the authenticated principal once a provider is chosen.
  // Deliberately one function, so there is a single place to fix rather than
  // seven route handlers reading a header.
  const principal = (req: { headers: Record<string, unknown> }): string =>
    (req.headers["x-user-id"] as string) ?? "anonymous";

  app.get("/privacy/consent", async (req, reply) => {
    const userId = principal(req);
    const state = consents.get(userId) ?? emptyConsent(userId);

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
    const state = consents.get(userId) ?? emptyConsent(userId);

    const updated = record(state, {
      scope: body.data.scope,
      granted: body.data.granted,
      decidedAt: new Date().toISOString(),
      noticeVersion: CURRENT_NOTICE_VERSION,
    });
    consents.set(userId, updated);

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
      scope: "SESSION",
      userId,
      sessionId: id,
      requestedAt: new Date().toISOString(),
    };

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

    const receipt = await executeDeletion(
      { scope: "ACCOUNT", userId, requestedAt: new Date().toISOString() },
      { eventLog: opts.eventLog, sessionsOf: async () => sessionIds, stores },
    );

    consents.delete(userId);
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
        payload: e.payload,
      })),
    });
  });
}
