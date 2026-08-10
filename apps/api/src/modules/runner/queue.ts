import type { RunResult } from "@master-leeter/contracts";
import { type CodeRunner, type RunRequest, RunnerUnavailableError } from "./runner.js";

/**
 * Run queue (M2-4).
 *
 * Execution is asynchronous from the API thread. A single runaway submission
 * must never pin the session service — the candidate's editor, timer, and voice
 * connection all live in that process, and losing them because someone wrote an
 * infinite loop would be an absurd way to fail an interview.
 *
 * In-process queue with bounded concurrency for the MVP. When runner demand
 * justifies it this becomes a real queue with separate workers; the interface
 * does not change, which is the point of having one.
 */

export interface QueuedRun {
  request: RunRequest;
  enqueuedAt: number;
}

export interface RunQueueOptions {
  runner: CodeRunner;
  /** Simultaneous executions. Beyond this, runs wait. */
  concurrency?: number;
  /** Queue depth before new runs are rejected outright. */
  maxDepth?: number;
  onResult: (result: RunResult) => void | Promise<void>;
  onUnavailable: (request: RunRequest, error: Error) => void | Promise<void>;
  now?: () => number;
}

export class RunQueue {
  private readonly pending: QueuedRun[] = [];
  private active = 0;
  private readonly concurrency: number;
  private readonly maxDepth: number;
  private readonly now: () => number;

  constructor(private readonly opts: RunQueueOptions) {
    this.concurrency = opts.concurrency ?? 4;
    this.maxDepth = opts.maxDepth ?? 64;
    this.now = opts.now ?? (() => Date.now());
  }

  get depth(): number {
    return this.pending.length;
  }

  get running(): number {
    return this.active;
  }

  /**
   * Enqueues a run. Returns false when the queue is saturated.
   *
   * Rejecting is kinder than queueing indefinitely: a candidate who clicks Run
   * and waits ninety seconds assumes their code hangs. Being told the runner is
   * busy is information; silence is not.
   */
  enqueue(request: RunRequest): boolean {
    if (this.pending.length >= this.maxDepth) return false;
    this.pending.push({ request, enqueuedAt: this.now() });
    void this.drain();
    return true;
  }

  private async drain(): Promise<void> {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) break;

      this.active++;
      void this.run(next).finally(() => {
        this.active--;
        // Draining again on completion is what keeps the queue moving without
        // a timer polling it.
        void this.drain();
      });
    }
  }

  private async run(item: QueuedRun): Promise<void> {
    try {
      const result = await this.opts.runner.execute(item.request);
      await this.opts.onResult(result);
    } catch (err) {
      // A runner outage is not an interview failure. The candidate is told
      // execution is unavailable and keeps reasoning and writing; the
      // orchestrator carries on without run events.
      const error =
        err instanceof RunnerUnavailableError ? err : new RunnerUnavailableError((err as Error).message);
      await this.opts.onUnavailable(item.request, error);
    }
  }
}
