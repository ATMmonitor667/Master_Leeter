import { z } from "zod";

/**
 * Consent and retention policy (M7-3).
 *
 * Invariant 10: no raw audio retention by default. That is expressed here as a
 * type where the default is off and turning it on requires an explicit,
 * timestamped grant — not a boolean somebody can flip in a config file and
 * later claim was always intended.
 *
 * The distinction that matters legally and ethically is between what the system
 * NEEDS to function and what it would merely LIKE to keep. Transcripts are
 * needed to score an interview. Raw audio is not — the design report is explicit
 * that the transcript is usually enough — so audio is opt-in and separately
 * deletable.
 */

export const CONSENT_SCOPES = [
  /** Store the finalized transcript. Required to produce a report at all. */
  "TRANSCRIPT",
  /** Retain raw microphone audio. OFF by default, always. */
  "RAW_AUDIO",
  /** Use this session as training or calibration data for the graders. */
  "CALIBRATION",
] as const;

export const ConsentScopeSchema = z.enum(CONSENT_SCOPES);
export type ConsentScope = z.infer<typeof ConsentScopeSchema>;

export const ConsentGrantSchema = z.object({
  scope: ConsentScopeSchema,
  granted: z.boolean(),
  /** When the user made this choice. A grant with no timestamp is not a grant. */
  decidedAt: z.string().datetime(),
  /** Version of the consent copy they were shown. Wording changes need re-consent. */
  noticeVersion: z.string().min(1),
});
export type ConsentGrant = z.infer<typeof ConsentGrantSchema>;

export const CURRENT_NOTICE_VERSION = "consent-2026-08-1";

/** Retention windows, in days. Zero means "do not retain at all". */
export const RETENTION_DAYS: Record<ConsentScope, number> = {
  TRANSCRIPT: 365,
  // Short by design. Audio is the highest-risk artifact the system can hold,
  // and the longer it exists the more it is worth to an attacker.
  RAW_AUDIO: 30,
  CALIBRATION: 730,
};

export interface ConsentState {
  userId: string;
  grants: ConsentGrant[];
}

export function emptyConsent(userId: string): ConsentState {
  return { userId, grants: [] };
}

/**
 * Whether a scope is permitted right now.
 *
 * Absence of a grant is a NO. There is no "assume yes until they object" branch,
 * and a grant against an outdated notice version does not count — if the wording
 * changed, they consented to something else.
 */
export function isPermitted(consent: ConsentState, scope: ConsentScope): boolean {
  const grant = latestGrant(consent, scope);
  if (!grant) return false;
  if (grant.noticeVersion !== CURRENT_NOTICE_VERSION) return false;
  return grant.granted;
}

export function latestGrant(consent: ConsentState, scope: ConsentScope): ConsentGrant | null {
  const forScope = consent.grants.filter((g) => g.scope === scope);
  if (forScope.length === 0) return null;

  return forScope.reduce((latest, g) =>
    Date.parse(g.decidedAt) >= Date.parse(latest.decidedAt) ? g : latest,
  );
}

/**
 * Records a decision.
 *
 * Append-only, like the event log. Keeping the history means "did they consent
 * at the time?" is answerable months later, which is the only version of that
 * question that matters.
 */
export function record(consent: ConsentState, grant: ConsentGrant): ConsentState {
  return { ...consent, grants: [...consent.grants, grant] };
}

/** Scopes that must be revoked and purged, given the current state. */
export function scopesToPurge(consent: ConsentState): ConsentScope[] {
  return CONSENT_SCOPES.filter((scope) => {
    const grant = latestGrant(consent, scope);
    // Explicit revocation, or a grant that no longer matches the current notice.
    return grant !== null && !isPermitted(consent, scope);
  });
}

/** Whether an artifact has outlived its retention window. */
export function isExpired(scope: ConsentScope, createdAt: string, nowMs: number): boolean {
  const days = RETENTION_DAYS[scope];
  if (days === 0) return true;
  return nowMs - Date.parse(createdAt) > days * 24 * 60 * 60 * 1000;
}
