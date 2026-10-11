import { afterEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { VoiceSession } from "./voice-session";
import { apiFetch } from "./api-client";

vi.mock("./api-client", () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      wsUrl: "wss://example.invalid", model: "models/test",
      automaticActivityDetectionDisabled: true,
    }),
  })),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("browser voice capture", () => {
  it.each([44_100, 48_000])("keeps capture active at %i Hz and recovers an undelivered voice turn", async (sampleRate) => {
    vi.stubEnv("NEXT_PUBLIC_ROOM_TONE", "off");
    const gains: Array<{ gain: { value: number }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const resume = vi.fn(async () => {});
    const destination = {};
    let options: AudioContextOptions | undefined;
    let worklet!: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
    let script = "";
    let provider!: { onopen?: () => void; onmessage?: (event: { data: unknown }) => void };
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      void (blob as Blob).text().then((text) => { script = text; });
      return "blob:capture";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.stubGlobal("AudioContext", class {
      sampleRate = sampleRate;
      state = "running";
      destination = destination;
      audioWorklet = { addModule: vi.fn(async () => {}) };
      resume = resume;
      close = vi.fn(async () => {});
      constructor(opts: AudioContextOptions) { options = opts; }
      createGain() {
        const node = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
        gains.push(node);
        return node;
      }
      createMediaStreamSource() { return source; }
    });
    vi.stubGlobal("AudioWorkletNode", class {
      port = {};
      connect = vi.fn();
      disconnect = vi.fn();
      constructor() { worklet = this; }
    });
    vi.stubGlobal("WebSocket", class {
      static OPEN = 1;
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: unknown }) => void;
      close = vi.fn();
      send = vi.fn();
      constructor() { provider = this; }
    });
    const track = { enabled: true, onended: null, stop: vi.fn() };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    vi.stubGlobal("navigator", { mediaDevices: {
      getUserMedia: vi.fn(async () => stream),
      enumerateDevices: vi.fn(async () => []),
    } });

    const errors: Error[] = [];
    const session = new VoiceSession({ apiBase: "http://example.invalid", sessionId: "test", onError: (err) => errors.push(err) });
    try {
      await session.start();
      expect(options).toEqual({ latencyHint: "interactive" });
      expect(resume).toHaveBeenCalledOnce();
      const captureGain = gains.at(-1)!;
      expect(captureGain.gain.value).toBe(0);
      expect(source.connect).toHaveBeenCalledWith(worklet);
      expect(worklet.connect).toHaveBeenCalledWith(captureGain);
      expect(captureGain.connect).toHaveBeenCalledWith(destination);

      // Execute the actual browser-loaded worklet, without microphone hardware.
      let Processor!: new () => { process(inputs: Float32Array[][]): boolean };
      const frames: Float32Array[] = [];
      runInNewContext(script, {
        sampleRate, Float32Array,
        AudioWorkletProcessor: class { port = { postMessage: (frame: Float32Array) => frames.push(frame) }; },
        registerProcessor: (_name: string, implementation: typeof Processor) => { Processor = implementation; },
      });
      const capture = new Processor();
      for (let i = 0; i < 20; i++) capture.process([[new Float32Array(128).fill(0.2)]]);
      expect(frames.length).toBeGreaterThan(1);
      expect(frames.every((frame) => frame.length === Math.round(sampleRate * 0.02))).toBe(true);
      expect(frames[0]?.[0]).toBeCloseTo(0.2);

      vi.useFakeTimers();
      provider.onopen?.();
      provider.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
      await vi.advanceTimersByTimeAsync(0);
      session.speak({ action: "DELIVER_BRIEF", utteranceId: "silent-brief" });
      provider.onmessage?.({ data: JSON.stringify({ serverContent: { turnComplete: true } }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(errors).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain("didn't return speech");
      expect(session.currentStatus).toBe("CONNECTING");
      const outcomes = vi.mocked(apiFetch).mock.calls.filter(([url]) => url.endsWith("voice-utterance-complete"));
      expect(outcomes.at(-1)?.[1]?.body).toContain('"outcome":"INTERRUPTED"');
    } finally {
      await session.stop();
    }
    expect(worklet.disconnect).toHaveBeenCalledOnce();
    expect(gains.at(-1)!.disconnect).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
  });
});
