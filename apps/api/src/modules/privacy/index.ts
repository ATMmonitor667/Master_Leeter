import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userIdFor } from "../auth/index.js";
import type { IdentityAdmin } from "../auth/identity-admin.js";
import type { EvaluationQueue } from "../report/index.js";
import type { EventLog } from "../session/event-log.js";
import type { SessionStore } from "../session/session-store.js";
import type { PreparationStore } from "../preparation/store.js";
import { SessionNotFoundError } from "../session/session-store.js";
import {
  CURRENT_NOTICE_VERSION,
  ConsentScopeSchema,
  RETENTION_DAYS,
  isPermitted,
} from "./consent.js";
import { InMemoryConsentStore, type ConsentStore } from "./consent-store.js";
import { type Deletable, type DeletionRequest, executeDeletion } from "./deletion.js";
import { InMemoryDeletionStore, type DeletionClaim, type DeletionStore, type NewDeletion } from "./deletion-store.js";
import type { SupportIncidentStore } from "../support/store.js";

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
export { InMemoryDeletionStore, type DeletionClaim, type DeletionReason, type DeletionStore } from "./deletion-store.js";
export { PgDeletionStore } from "./pg-deletion-store.js";
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
  deletionStore?: DeletionStore;
  sessionRetentionDays?: number;
  identityAdmin?: IdentityAdmin;
  supportStore?: SupportIncidentStore;
  onMaintenanceFailure?: (consecutiveFailures: number) => void;
}

export async function registerPrivacyModule(
  app: FastifyInstance,
  opts: PrivacyModuleOptions,
): Promise<void> {
  const consents = opts.consentStore ?? new InMemoryConsentStore();
  const deletions = opts.deletionStore ?? new InMemoryDeletionStore();

  const stores: Deletable[] = [
    new ReportStore(opts.evaluationQueue ?? {}),
    new AudioStore(),
    ...(opts.supportStore ? [opts.supportStore] : []),
    ...(opts.preparationStore ? [{
      name: "preparations",
      deleteForSession: (sessionId: string) => opts.preparationStore!.deleteForSession(sessionId),
      deleteForUser: (userId: string) => opts.preparationStore!.deleteForUser(userId),
    }] : []),
  ];

  const principal = userIdFor;
  const leaseMs = 2 * 60_000;

  async function processDeletion(claim: DeletionClaim) {
    const available: string[] = [];
    for (const id of claim.sessionIds) {
      try { await opts.sessions.tombstone(id, claim.requestedAt); available.push(id); }
      catch (error) { if (!(error instanceof SessionNotFoundError)) throw error; }
    }
    const request: DeletionRequest = {
      scope: claim.scope, userId: claim.userId, requestedAt: claim.requestedAt,
      ...(claim.scope === "SESSION" && available[0] ? { sessionId: available[0] } : {}),
    };
    const receipt = await executeDeletion(request, {
      eventLog: opts.eventLog,
      sessionsOf: async () => available,
      stores,
    });
    if (receipt.unreachable.length) throw new Error("DELETION_INCOMPLETE");
    if (claim.scope === "ACCOUNT") await consents.deleteForUser(claim.userId);
    await deletions.complete(claim.id, claim.token, receipt);
    return receipt;
  }

  async function submitDeletion(input: NewDeletion) {
    const queued = input.scope === "ACCOUNT"
      ? await deletions.pendingForUser(input.userId) ?? await deletions.enqueue(input)
      : await deletions.enqueue(input);
    if (queued.completedAt && queued.receipt) return queued.receipt;
    const claim = await deletions.claim(queued.id, leaseMs);
    if (!claim) throw new Error("DELETION_BUSY");
    try { return await processDeletion(claim); }
    catch (error) { await deletions.release(claim.id, claim.token); throw error; }
  }

  let maintenance: Promise<void> | undefined;
  let consecutiveFailures = 0;
  const maintain = (): Promise<void> => {
    maintenance ??= (async () => {
      let incomplete = false;
      const recovered = await deletions.recoverable(20, leaseMs);
      for (const claim of recovered) {
        try { await processDeletion(claim); }
        catch { incomplete = true; await deletions.release(claim.id, claim.token); app.log.error("privacy deletion recovery failed"); }
      }
      const days = opts.sessionRetentionDays ?? RETENTION_DAYS.TRANSCRIPT;
      const before = new Date(Date.now() - days * 86_400_000).toISOString();
      for (const session of await opts.sessions.expiredEnded(before, 20)) {
        try {
          await submitDeletion({
            dedupeKey: `session:${session.id}`, scope: "SESSION", reason: "RETENTION",
            userId: session.userId, sessionIds: [session.id], requestedAt: new Date().toISOString(),
          });
        } catch { incomplete = true; app.log.error("expired session deletion failed"); }
      }
      if (incomplete) throw new Error("PRIVACY_MAINTENANCE_INCOMPLETE");
      consecutiveFailures = 0;
    })().catch(() => {
      // A database outage must not leave a rejected interval promise that can
      // terminate the API. Durable requests stay pending for the next attempt.
      consecutiveFailures += 1;
      if (consecutiveFailures === 1 || consecutiveFailures % 12 === 0) {
        app.log.error({ consecutiveFailures }, "privacy maintenance unavailable");
        opts.onMaintenanceFailure?.(consecutiveFailures);
      }
    }).finally(() => { maintenance = undefined; });
    return maintenance;
  };
  const maintenanceTimer = setInterval(() => { void maintain(); }, 60_000);
  maintenanceTimer.unref();
  app.addHook("onReady", maintain);
  app.addHook("onClose", async () => { clearInterval(maintenanceTimer); await maintenance; });

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

    if (session.userId !== userId) {
      return reply.code(403).send({ error: "NOT_YOURS" });
    }

    if (!session.endedAt) return reply.code(409).send({ error: "END_SESSION_BEFORE_DELETION" });
    const requestedAt = new Date().toISOString();
    try {
      return reply.send(await submitDeletion({
        dedupeKey: `session:${id}`, scope: "SESSION", reason: "USER_REQUEST",
        userId, sessionIds: [id], requestedAt,
      }));
    } catch { return reply.code(503).send({ error: "DELETION_PENDING" }); }
  });

  app.delete("/privacy/account", async (req, reply) => {
    const userId = principal(req);
    const sessionIds = (await opts.sessions.idsForUser?.(userId)) ?? [];
    for (const id of sessionIds) {
      if (!(await opts.sessions.get(id))?.endedAt) return reply.code(409).send({ error: "END_SESSION_BEFORE_DELETION" });
    }
    const requestedAt = new Date().toISOString();
    try {
      return reply.send(await submitDeletion({
        dedupeKey: `account:${userId}:${requestedAt}`, scope: "ACCOUNT", reason: "USER_REQUEST",
        userId, sessionIds, requestedAt,
      }));
    } catch { return reply.code(503).send({ error: "DELETION_PENDING" }); }
  });

  app.delete("/privacy/account/identity", async (req, reply) => {
    if (!opts.identityAdmin) return reply.code(503).send({ error: "IDENTITY_DELETION_UNAVAILABLE" });
    const userId = principal(req);
    const sessionIds = await opts.sessions.idsForUser(userId);
    for (const id of sessionIds) {
      if (!(await opts.sessions.get(id))?.endedAt) return reply.code(409).send({ error: "END_SESSION_BEFORE_DELETION" });
    }
    const requestedAt = new Date().toISOString();
    try {
      const receipt = await submitDeletion({
        dedupeKey: `account:${userId}:${requestedAt}`, scope: "ACCOUNT", reason: "USER_REQUEST",
        userId, sessionIds, requestedAt,
      });
      await opts.identityAdmin.deleteUser(userId);
      return reply.send({ ...receipt, identityDeleted: true });
    } catch { return reply.code(503).send({ error: "ACCOUNT_DELETION_PENDING" }); }
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
