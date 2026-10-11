import { describe, expect, it } from "vitest";
import { energySlope, pitchSlope, NullTurnEndPredictor, ProsodicTurnEndPredictor } from "./turn-predictor";

function frame(hz: number, amplitude = 0.2, sampleRate = 16_000): Float32Array {
  return Float32Array.from({ length: sampleRate / 25 }, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / sampleRate));
}

describe("prosodic turn evidence", () => {
  it("keeps the disabled predictor neutral", () => {
    const predictor = new NullTurnEndPredictor();
    expect(predictor.estimate()).toMatchObject({ probability: 0.5, confidence: 0 });
  });

  it("does not infer a yielded turn from silence or a short voiced fragment", () => {
    const predictor = new ProsodicTurnEndPredictor();
    for (let i = 0; i < 20; i++) predictor.push(new Float32Array(640), 16_000, i * 40);
    expect(predictor.estimate(800)).toMatchObject({ probability: 0.5, confidence: 0 });
    for (let i = 0; i < 7; i++) predictor.push(frame(150), 16_000, 1000 + i * 40);
    expect(predictor.estimate(1240)).toMatchObject({ probability: 0.5, confidence: 0 });
  });

  it("reads the backdated speech boundary without incorporating future audio", () => {
    const predictor = new ProsodicTurnEndPredictor();
    for (let i = 0; i < 20; i++) predictor.push(frame(180 - i * 2, 0.2 - i * 0.005), 16_000, i * 40);
    const boundary = predictor.estimate(760);
    expect(boundary.confidence).toBeGreaterThan(0);
    expect(boundary.features.terminalPitchSlopeSemitonesPerSec).toBeLessThan(0);
    for (let i = 0; i < 10; i++) predictor.push(frame(300), 16_000, 800 + i * 40);
    expect(predictor.estimate(760)).toEqual(boundary);
    predictor.reset();
    expect(predictor.estimate(1200)).toMatchObject({ probability: 0.5, confidence: 0 });
  });

  it("discards expired evidence rather than carrying a previous turn into a new one", () => {
    const predictor = new ProsodicTurnEndPredictor();
    for (let i = 0; i < 20; i++) predictor.push(frame(150), 16_000, i * 40);
    predictor.push(new Float32Array(640), 16_000, 5000);
    expect(predictor.estimate(5000)).toMatchObject({ confidence: 0, probability: 0.5 });
  });

  it("measures pitch changes consistently across high and low voices", () => {
    const low = [100, 110, 121].map((f0, i) => ({ f0, atMs: i * 100 }));
    const high = low.map((point) => ({ ...point, f0: point.f0 * 2 }));
    expect(pitchSlope(low)).toBeCloseTo(pitchSlope(high)!);
    expect(pitchSlope(low)).toBeGreaterThan(0);
    expect(pitchSlope(low.map((point) => ({ ...point, atMs: 0 })))).toBeNull();
  });

  it("ignores non-finite energy samples and requires enough usable measurements", () => {
    expect(energySlope([{ atMs: 0, db: NaN }, { atMs: 100, db: -10 }, { atMs: 200, db: -20 }])).toBeNull();
    expect(energySlope([{ atMs: 0, db: -10 }, { atMs: 100, db: -20 }, { atMs: 200, db: -30 }])).toBeCloseTo(-100);
  });
});
