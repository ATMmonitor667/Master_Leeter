import { describe, expect, it } from "vitest";
import { ProviderCircuit } from "./provider-circuit.js";

describe("provider outage containment", () => {
  it("requires consecutive failures and resets the counter after success", () => {
    const circuit = new ProviderCircuit(2, 100, () => 1000);
    circuit.failure(); circuit.success(); circuit.failure();
    expect(circuit.tryAcquire()).toBe(true);
    circuit.failure();
    expect(circuit.state()).toBe("OPEN");
    expect(circuit.tryAcquire()).toBe(false);
  });

  it("opens immediately on quota exhaustion and allows only one recovery probe", () => {
    let now = 1000;
    const circuit = new ProviderCircuit(3, 100, () => now);
    circuit.failure(true);
    now = 1099;
    expect(circuit.tryAcquire()).toBe(false);
    now = 1100;
    expect(circuit.state()).toBe("HALF_OPEN");
    expect(circuit.tryAcquire()).toBe(true);
    expect(circuit.tryAcquire()).toBe(false);
    circuit.success();
    expect(circuit.state()).toBe("CLOSED");
    expect(circuit.tryAcquire()).toBe(true);
  });

  it("reopens for the full cooldown after a failed probe", () => {
    let now = 1000;
    const circuit = new ProviderCircuit(3, 100, () => now);
    circuit.failure(true); now += 100;
    expect(circuit.tryAcquire()).toBe(true);
    circuit.failure(); now += 99;
    expect(circuit.tryAcquire()).toBe(false);
    now += 1;
    expect(circuit.tryAcquire()).toBe(true);
    circuit.release();
    expect(circuit.tryAcquire()).toBe(true);
  });
});
