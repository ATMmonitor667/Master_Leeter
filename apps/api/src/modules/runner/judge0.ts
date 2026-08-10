import type { RunResult, RunStatus } from "@master-leeter/contracts";
import {
  type CodeRunner,
  type RunRequest,
  RunnerUnavailableError,
  hashInput,
  truncateOutput,
} from "./runner.js";

/**
 * Judge0 adapter (ADR-006 — buy isolation, don't build it).
 *
 * UNVERIFIED against a live Judge0. There is no instance in CI, so this has been
 * written against the documented API and typechecks, but nobody has watched it
 * kill a fork bomb. M0-2 is the issue that turns this from plausible into
 * verified, and it needs an instance to point at.
 *
 * The security posture is expressed here as explicit per-submission limits
 * rather than trusting instance defaults. A misconfigured server should produce
 * a failed run, not an unbounded one.
 */

/** Judge0 language ids. Python 3 is 71; the MVP ships one language. */
const LANGUAGE_IDS: Record<string, number> = { python: 71 };

/** Judge0 status ids, mapped onto our normalized set. */
const STATUS_MAP: Record<number, RunStatus> = {
  1: "INTERNAL_ERROR", // In Queue
  2: "INTERNAL_ERROR", // Processing
  3: "PASSED", // Accepted
  4: "FAILED", // Wrong Answer
  5: "TIMEOUT", // Time Limit Exceeded
  6: "COMPILE_ERROR",
  7: "RUNTIME_ERROR", // SIGSEGV
  8: "RUNTIME_ERROR", // SIGXFSZ
  9: "RUNTIME_ERROR", // SIGFPE
  10: "RUNTIME_ERROR", // SIGABRT
  11: "RUNTIME_ERROR", // NZEC
  12: "RUNTIME_ERROR", // Other
  13: "INTERNAL_ERROR",
  14: "INTERNAL_ERROR", // Exec Format Error
};

interface Judge0Submission {
  status?: { id: number; description: string };
  stdout?: string | null;
  stderr?: string | null;
  compile_output?: string | null;
  message?: string | null;
  time?: string | null;
  memory?: number | null;
  exit_code?: number | null;
}

export interface Judge0Options {
  baseUrl: string;
  authToken?: string;
  fetchImpl?: typeof fetch;
  /** How long to wait for a synchronous submission before giving up. */
  requestTimeoutMs?: number;
}

export class Judge0Runner implements CodeRunner {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: Judge0Options) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/about`, { headers: this.headers() });
      return res.ok;
    } catch {
      return false;
    }
  }

  async execute(req: RunRequest): Promise<RunResult> {
    const languageId = LANGUAGE_IDS[req.language];
    if (languageId === undefined) {
      throw new RunnerUnavailableError(`unsupported language "${req.language}"`);
    }

    const body = {
      language_id: languageId,
      source_code: req.source,
      stdin: req.stdin,

      // Limits are sent per submission rather than trusted from instance
      // defaults. A misconfigured server should fail a run, not run unbounded.
      cpu_time_limit: req.limits.cpuSeconds,
      wall_time_limit: req.limits.wallSeconds,
      memory_limit: req.limits.memoryKb,
      max_processes_and_or_threads: req.limits.maxProcesses,
      enable_per_process_and_thread_time_limit: false,
      enable_per_process_and_thread_memory_limit: true,
      max_file_size: 4096,

      // Invariant 6: no network from candidate code, ever.
      enable_network: false,
      redirect_stderr_to_stdout: false,
    };

    let submission: Judge0Submission;
    try {
      const res = await this.fetchImpl(
        `${this.opts.baseUrl}/submissions?base64_encoded=false&wait=true`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...this.headers() },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 30_000),
        },
      );

      if (!res.ok) throw new RunnerUnavailableError(`judge0 responded ${res.status}`);
      submission = (await res.json()) as Judge0Submission;
    } catch (err) {
      if (err instanceof RunnerUnavailableError) throw err;
      throw new RunnerUnavailableError((err as Error).message);
    }

    return this.normalize(req, submission);
  }

  private normalize(req: RunRequest, s: Judge0Submission): RunResult {
    const statusId = s.status?.id ?? 13;
    const status = STATUS_MAP[statusId] ?? "INTERNAL_ERROR";

    // Judge0 reports OOM as a generic runtime error. The message is the only
    // way to tell "your algorithm allocates too much" from "your code crashed",
    // and those deserve different probes.
    const message = s.message ?? "";
    const isOom = /memory limit/i.test(message) || /out of memory/i.test(s.stderr ?? "");

    const stdout = truncateOutput(s.stdout ?? "", req.limits.maxOutputBytes);
    const stderrRaw = s.stderr || s.compile_output || message || "";
    const stderr = truncateOutput(stderrRaw, req.limits.maxOutputBytes);

    return {
      runId: req.runId,
      language: req.language,
      codeRevision: req.codeRevision,
      inputHash: hashInput(req.stdin),
      status: isOom ? "MEMORY_EXCEEDED" : status,
      exitCode: s.exit_code ?? null,
      cpuTimeMs: Math.round(Number(s.time ?? 0) * 1000),
      memoryKb: s.memory ?? 0,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
    };
  }

  private headers(): Record<string, string> {
    return this.opts.authToken ? { "x-auth-token": this.opts.authToken } : {};
  }
}
