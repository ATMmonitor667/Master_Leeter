export type OperationalAlert =
  | {
      kind: "REPORT_EVALUATION_EXHAUSTED";
      sessionId: string;
      attempts: number;
      code: string;
    }
  | {
      kind: "REPORT_RECOVERY_UNAVAILABLE";
      consecutiveFailures: number;
    }
  | {
      kind: "REALTIME_CIRCUIT_OPEN";
      sessionId: string;
      failureKind: string;
    };

export interface OperationalAlertSink {
  publish(alert: OperationalAlert): Promise<void>;
}

export interface WebhookAlertSinkOptions {
  url: string;
  release: string;
  token?: string;
  fetch?: typeof fetch;
  now?: () => string;
  timeoutMs?: number;
}

/**
 * Sends only a closed, redacted alert schema. Candidate content and provider
 * errors cannot be added accidentally through an open-ended details object.
 */
export class WebhookAlertSink implements OperationalAlertSink {
  private readonly fetcher: typeof fetch;
  private readonly now: () => string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: WebhookAlertSinkOptions) {
    this.fetcher = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  async publish(alert: OperationalAlert): Promise<void> {
    const body = JSON.stringify({ ...alert, severity: "critical", release: this.opts.release, occurredAt: this.now() });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await this.fetcher(this.opts.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "master-leeter-operations/1",
            ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) return;
        await response.body?.cancel();
        if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
      } catch {
        // Retry transient network/timeout failures below; never expose the URL.
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
    throw new Error("OPERATIONAL_ALERT_DELIVERY_FAILED");
  }
}
