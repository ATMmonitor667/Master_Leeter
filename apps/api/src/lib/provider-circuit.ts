export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/** Small process-level breaker; durable rate/admission limits remain the hard cap. */
export class ProviderCircuit {
  private failures = 0;
  private openUntil = 0;
  private probeInFlight = false;

  constructor(
    private readonly failureThreshold = 3,
    private readonly cooldownMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(failureThreshold) || failureThreshold < 1 || cooldownMs < 1) {
      throw new Error("INVALID_CIRCUIT_CONFIGURATION");
    }
  }

  tryAcquire(): boolean {
    if (this.openUntil === 0) return true;
    if (this.now() < this.openUntil || this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  success(): void {
    this.failures = 0;
    this.openUntil = 0;
    this.probeInFlight = false;
  }

  failure(immediate = false): void {
    const failedProbe = this.probeInFlight;
    this.probeInFlight = false;
    this.failures += 1;
    if (immediate || failedProbe || this.failures >= this.failureThreshold) {
      this.openUntil = this.now() + this.cooldownMs;
      this.failures = 0;
    }
  }

  release(): void {
    this.probeInFlight = false;
  }

  state(): CircuitState {
    if (this.openUntil === 0) return "CLOSED";
    return this.now() < this.openUntil ? "OPEN" : "HALF_OPEN";
  }
}
