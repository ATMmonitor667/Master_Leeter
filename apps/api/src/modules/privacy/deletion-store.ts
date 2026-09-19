import { randomUUID } from "node:crypto";
import type { DeletionReceipt, DeletionScope } from "./deletion.js";

export type DeletionReason = "USER_REQUEST" | "RETENTION" | "RESTORE_REPLAY";
export interface DeletionRecord {
  id: string;
  dedupeKey: string;
  scope: DeletionScope;
  reason: DeletionReason;
  userId: string;
  sessionIds: string[];
  requestedAt: string;
  completedAt: string | null;
  receipt: DeletionReceipt | null;
}
export interface DeletionClaim extends DeletionRecord { token: string }
export type NewDeletion = Omit<DeletionRecord, "id" | "completedAt" | "receipt">;

export interface DeletionStore {
  enqueue(input: NewDeletion): Promise<DeletionRecord>;
  pendingForUser(userId: string): Promise<DeletionRecord | null>;
  claim(id: string, leaseMs: number): Promise<DeletionClaim | null>;
  recoverable(limit: number, leaseMs: number): Promise<DeletionClaim[]>;
  complete(id: string, token: string, receipt: DeletionReceipt): Promise<void>;
  release(id: string, token: string): Promise<void>;
}

export class InMemoryDeletionStore implements DeletionStore {
  private readonly records = new Map<string, DeletionRecord>();
  private readonly ids = new Map<string, string>();
  private readonly leases = new Map<string, { token: string; expires: number }>();
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}
  async enqueue(input: NewDeletion): Promise<DeletionRecord> {
    const existing = this.ids.get(input.dedupeKey);
    if (existing) return structuredClone(this.records.get(existing)!);
    const record: DeletionRecord = { ...input, id: randomUUID(), completedAt: null, receipt: null };
    this.records.set(record.id, record); this.ids.set(record.dedupeKey, record.id);
    return structuredClone(record);
  }
  async claim(id: string, leaseMs: number): Promise<DeletionClaim | null> {
    const record = this.records.get(id); const lease = this.leases.get(id);
    if (!record || record.completedAt || (lease && lease.expires > Date.now())) return null;
    const token = randomUUID(); this.leases.set(id, { token, expires: Date.now() + leaseMs });
    return { ...structuredClone(record), token };
  }
  async pendingForUser(userId: string): Promise<DeletionRecord | null> {
    const found = [...this.records.values()].find((record) => record.scope === "ACCOUNT" && record.userId === userId && !record.completedAt);
    return found ? structuredClone(found) : null;
  }
  async recoverable(limit: number, leaseMs: number): Promise<DeletionClaim[]> {
    const claims: DeletionClaim[] = [];
    for (const record of this.records.values()) {
      const claim = await this.claim(record.id, leaseMs); if (claim) claims.push(claim);
      if (claims.length >= limit) break;
    }
    return claims;
  }
  async complete(id: string, token: string, receipt: DeletionReceipt): Promise<void> {
    if (this.leases.get(id)?.token !== token) throw new Error("DELETION_CLAIM_LOST");
    const record = this.records.get(id); if (!record) throw new Error("DELETION_NOT_FOUND");
    this.records.set(id, { ...record, completedAt: this.now(), receipt: structuredClone(receipt) });
    this.leases.delete(id);
  }
  async release(id: string, token: string): Promise<void> {
    if (this.leases.get(id)?.token === token) this.leases.delete(id);
  }
}
