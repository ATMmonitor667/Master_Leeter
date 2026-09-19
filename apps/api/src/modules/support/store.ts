import { randomUUID } from "node:crypto";
import type { InterviewState } from "@master-leeter/contracts";
import type { Deletable } from "../privacy/deletion.js";

export const SUPPORT_CATEGORIES = ["VOICE", "CONNECTION", "SAVING", "REPORT", "OTHER"] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
export type SupportVoiceStatus = "IDLE" | "CONNECTING" | "LISTENING" | "SPEAKING" | "FAILED";

export interface SupportDiagnostics {
  connected: boolean;
  online: boolean;
  visibility: "visible" | "hidden";
  pendingSaves: number;
  stage: InterviewState;
  voiceStatus: SupportVoiceStatus;
}

export interface NewSupportIncident {
  idempotencyKey: string;
  userId: string;
  sessionId: string;
  category: SupportCategory;
  diagnostics: SupportDiagnostics;
  requestId: string;
  createdAt: string;
  expiresAt: string;
}

export interface SupportIncident extends NewSupportIncident {
  id: string;
}

export interface SupportIncidentStore extends Deletable {
  readonly name: "support incidents";
  create(input: NewSupportIncident): Promise<SupportIncident>;
  purgeExpired(at: string): Promise<number>;
}

export class InMemorySupportIncidentStore implements SupportIncidentStore {
  readonly name = "support incidents" as const;
  private readonly incidents = new Map<string, SupportIncident>();
  private readonly idempotency = new Map<string, string>();

  async create(input: NewSupportIncident): Promise<SupportIncident> {
    const key = `${input.userId}:${input.idempotencyKey}`;
    const prior = this.idempotency.get(key);
    if (prior) return structuredClone(this.incidents.get(prior)!);
    const incident = { ...structuredClone(input), id: randomUUID() };
    this.incidents.set(incident.id, incident);
    this.idempotency.set(key, incident.id);
    return structuredClone(incident);
  }

  async purgeExpired(at: string): Promise<number> {
    let removed = 0;
    for (const [id, incident] of this.incidents) {
      if (incident.expiresAt > at) continue;
      this.incidents.delete(id);
      this.idempotency.delete(`${incident.userId}:${incident.idempotencyKey}`);
      removed += 1;
    }
    return removed;
  }

  async deleteForSession(sessionId: string): Promise<number> {
    return this.remove((incident) => incident.sessionId === sessionId);
  }

  async deleteForUser(userId: string): Promise<number> {
    return this.remove((incident) => incident.userId === userId);
  }

  private remove(matches: (incident: SupportIncident) => boolean): number {
    let removed = 0;
    for (const [id, incident] of this.incidents) {
      if (!matches(incident)) continue;
      this.incidents.delete(id);
      this.idempotency.delete(`${incident.userId}:${incident.idempotencyKey}`);
      removed += 1;
    }
    return removed;
  }
}
