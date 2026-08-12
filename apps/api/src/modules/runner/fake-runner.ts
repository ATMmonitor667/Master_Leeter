import type { RunResult } from "@master-leeter/contracts";
import { type CodeRunner, type RunRequest, hashInput } from "./runner.js";

/**
 * Scripted runner for tests and local development.
 *
 * A test fixture, never production code — the same rule as candidate bots. It
 * exists so the queue, milestone detection, and the workspace can all be
 * exercised without any judge at all — and deterministically, which the model
 * judge is not. Tests must never depend on a model call.
 */
export class FakeRunner implements CodeRunner {
  private readonly scripted: RunResult[] = [];
  private up = true;
  readonly executed: RunRequest[] = [];

  queueResult(partial: Partial<RunResult>): void {
    this.scripted.push({
      runId: "fake",
      language: "python",
      codeRevision: 0,
      inputHash: hashInput(""),
      status: "PASSED",
      exitCode: 0,
      cpuTimeMs: 12,
      memoryKb: 4096,
      stdout: "",
      stderr: "",
      truncated: false,
      ...partial,
    });
  }

  setHealthy(healthy: boolean): void {
    this.up = healthy;
  }

  async healthy(): Promise<boolean> {
    return this.up;
  }

  async execute(req: RunRequest): Promise<RunRequest extends never ? never : RunResult> {
    this.executed.push(req);
    if (!this.up) throw new Error("fake runner is down");

    const next = this.scripted.shift();
    if (!next) throw new Error("FakeRunner has no scripted result queued");

    // Always stamp the requested revision, so a test cannot accidentally assert
    // against a result that could not have come from this request.
    return { ...next, runId: req.runId, codeRevision: req.codeRevision };
  }
}
