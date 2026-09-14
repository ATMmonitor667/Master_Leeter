import { emptyConsent, record, type ConsentGrant, type ConsentState } from "./consent.js";

export interface ConsentStore {
  get(userId: string): Promise<ConsentState>;
  record(userId: string, grant: ConsentGrant): Promise<ConsentState>;
  deleteForUser(userId: string): Promise<number>;
}

export class InMemoryConsentStore implements ConsentStore {
  private readonly states = new Map<string, ConsentState>();

  async get(userId: string): Promise<ConsentState> {
    return structuredClone(this.states.get(userId) ?? emptyConsent(userId));
  }

  async record(userId: string, grant: ConsentGrant): Promise<ConsentState> {
    const updated = record(await this.get(userId), grant);
    this.states.set(userId, structuredClone(updated));
    return updated;
  }

  async deleteForUser(userId: string): Promise<number> {
    return this.states.delete(userId) ? 1 : 0;
  }
}
