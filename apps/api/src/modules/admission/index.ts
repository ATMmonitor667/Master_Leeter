import { createHash } from "node:crypto";
import type { QueryClient } from "../session/pg-event-log.js";

export interface SessionAdmissionPolicy {
  enabled: boolean;
  maxActiveInterviews: number;
  monthlyInterviewsPerUser: number;
  maxRealtimeMintsPerSession: number;
}

export interface RateLimitPolicy {
  sessionCreatesPerMinute: number;
  preparationsPerMinute: number;
  realtimeMintsPerMinute: number;
  runRequestsPerMinute: number;
  supportReportsPerMinute: number;
}

export interface RateLimitDecision { allowed: boolean; retryAfterSeconds: number }
export interface RateLimitStore {
  take(key: string, limit: number, windowMs: number, now?: number): Promise<RateLimitDecision>;
}

interface Bucket { count: number; expiresAt: number }

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();

  async take(key: string, limit: number, windowMs: number, now = Date.now()): Promise<RateLimitDecision> {
    assertLimit(limit, windowMs);
    const prior = this.buckets.get(key);
    const bucket = !prior || prior.expiresAt <= now
      ? { count: 1, expiresAt: now + windowMs }
      : { count: prior.count + 1, expiresAt: prior.expiresAt };
    this.buckets.set(key, bucket);
    return decision(bucket.count, limit, bucket.expiresAt, now);
  }
}

export class PgRateLimitStore implements RateLimitStore {
  constructor(private readonly db: QueryClient) {}

  async take(key: string, limit: number, windowMs: number, now = Date.now()): Promise<RateLimitDecision> {
    assertLimit(limit, windowMs);
    const bucketKey = createHash("sha256").update(key).digest("hex");
    const at = new Date(now).toISOString();
    const expiresAt = new Date(now + windowMs).toISOString();
    const result = await this.db.query<{ count: number; expires_at: Date | string }>(`
      INSERT INTO public.api_rate_limits (bucket_key,count,expires_at)
      VALUES ($1,1,$3::timestamptz)
      ON CONFLICT (bucket_key) DO UPDATE SET
        count=CASE WHEN public.api_rate_limits.expires_at <= $2::timestamptz
          THEN 1 ELSE public.api_rate_limits.count + 1 END,
        expires_at=CASE WHEN public.api_rate_limits.expires_at <= $2::timestamptz
          THEN $3::timestamptz ELSE public.api_rate_limits.expires_at END
      RETURNING count,expires_at`, [bucketKey, at, expiresAt]);
    const bucket = result.rows[0];
    if (!bucket) throw new Error("RATE_LIMIT_WRITE_FAILED");
    return decision(bucket.count, limit, new Date(bucket.expires_at).getTime(), now);
  }
}

function assertLimit(limit: number, windowMs: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error("INVALID_RATE_LIMIT");
  }
}

function decision(count: number, limit: number, expiresAt: number, now: number): RateLimitDecision {
  return { allowed: count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1_000)) };
}

export type AdmissionErrorCode =
  | "ADMISSION_PAUSED"
  | "GLOBAL_CAPACITY_REACHED"
  | "ACTIVE_SESSION_EXISTS"
  | "MONTHLY_QUOTA_REACHED";

export class AdmissionError extends Error {
  constructor(readonly code: AdmissionErrorCode) { super(code); }
}
