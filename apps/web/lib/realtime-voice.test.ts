import { describe, expect, it } from "vitest";
import { pcm16ToBase64 } from "./audio";
import {
  RealtimeVoice,
  type RealtimeTransport,
  type RealtimeTransportHandlers,
  type SpeechBoundary,
  type VoiceCredential,
  type VoiceToolCall,
} from "./realtime-voice";
import { Vad } from "./vad";

/**
 * The invariant under test is a negative — "nothing here can make the model
 * speak" — so most of this file drives every public method and then inspects
 * everything that went out on the wire.
 */

const CREDENTIAL: VoiceCredential = {
  wsUrl: "wss://example.invalid/live",
  model: "models/gemini-live",
  automaticActivityDetectionDisabled: true,
};

interface Harness {
  voice: RealtimeVoice;
  sent: Array<Record<string, unknown>>;
  boundaries: SpeechBoundary[];
  audio: Int16Array[];
  bargeIns: number;
  errors: Error[];
  handlers: RealtimeTransportHandlers;
  receive: (msg: unknown) => void;
  /** Drives frames at a level until the VAD reacts. */
  speak: (ms: number) => void;
  quiet: (ms: number) => void;
  clock: () => number;
}

function build(
  options: {
    vad?: Vad;
    callTool?: (call: VoiceToolCall) => Promise<Record<string, unknown>>;
  } = {},
): Harness {
  const sent: Array<Record<string, unknown>> = [];
  const boundaries: SpeechBoundary[] = [];
  const audio: Int16Array[] = [];
  const errors: Error[] = [];
  let bargeIns = 0;
  let t = 0;
  let handlers!: RealtimeTransportHandlers;

  const transport: RealtimeTransport = {
    send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
    close: () => {},
    connected: true,
  };

  const voice = new RealtimeVoice({
    credential: CREDENTIAL,
    captureRate: 48_000,
    ...(options.vad ? { vad: options.vad } : {}),
    ...(options.callTool ? { callTool: options.callTool } : {}),
    now: () => t,
    connect: (h) => {
      handlers = h;
      return transport;
    },
    onSpeechBoundary: (b) => boundaries.push(b),
    onModelAudio: (pcm) => audio.push(pcm),
    onBargeIn: () => {
      bargeIns += 1;
    },
    onError: (e) => errors.push(e),
  });

  voice.connect();
  handlers.onOpen();
  handlers.onMessage(JSON.stringify({ setupComplete: {} }));

  const FRAME = 20;
  const CAPTURE_FRAME = Math.floor((48_000 * FRAME) / 1000);

  const drive = (ms: number, amplitude: number): void => {
    for (let elapsed = 0; elapsed < ms; elapsed += FRAME) {
      const frame = new Float32Array(CAPTURE_FRAME);
      if (amplitude > 0) {
        for (let i = 0; i < frame.length; i++) {
          frame[i] = amplitude * Math.sin((2 * Math.PI * 300 * i) / 48_000);
        }
      }
      voice.pushAudio(frame, t);
      t += FRAME;
    }
  };

  // Let the VAD calibrate against room tone before anything is asserted.
  drive(700, 0.0005);

  const harness: Harness = {
    voice,
    sent,
    boundaries,
    audio,
    get bargeIns() {
      return bargeIns;
    },
    errors,
    handlers,
    receive: (msg) => handlers.onMessage(JSON.stringify(msg)),
    speak: (ms) => drive(ms, 0.3),
    quiet: (ms) => drive(ms, 0.0005),
    clock: () => t,
  } as Harness;

  return harness;
}

/** Every message the class has ever sent, flattened to top-level keys. */
function sentKinds(sent: Array<Record<string, unknown>>): string[] {
  return sent.flatMap((m) => Object.keys(m));
}

describe("only an authorization can make the model speak", () => {
  /**
   * The narrowed guarantee after M3-5.
   *
   * Audio is produced by clientContent with turnComplete. Exactly one method
   * sends it and it takes a server-minted authorization; everything the
   * microphone drives must remain incapable — invariant 1 as class design
   * rather than a convention someone has to remember.
   */
  it("never sends clientContent from any input-driven path", () => {
    const h = build();

    h.speak(400);
    h.quiet(800);
    h.speak(300);
    h.voice.setMuted(true);
    h.voice.setMuted(false);
    h.speak(200);
    h.receive({ serverContent: { turnComplete: true } });
    h.voice.disconnect();

    const wire = JSON.stringify(h.sent);
    expect(wire).not.toContain("clientContent");
    expect(wire).not.toContain("client_content");
    expect(wire).not.toContain("turnComplete");
    expect(wire).not.toContain("turn_complete");
  });

  it("only ever sends setup, audio, and activity boundaries", () => {
    const h = build();
    h.speak(400);
    h.quiet(800);

    expect(new Set(sentKinds(h.sent))).toEqual(new Set(["setup", "realtimeInput"]));
  });

  it("speaks when, and only when, handed an authorization", () => {
    const h = build();
    h.speak(400);
    h.quiet(800);
    expect(JSON.stringify(h.sent)).not.toContain("turnComplete");

    h.voice.requestSpeech({ action: "ASK_PROBE", utteranceId: "utt-turn-7" });

    const content = h.sent.find((m) => m["clientContent"]) as
      | { clientContent: { turnComplete: boolean; turns: Array<{ parts: Array<{ text: string }> }> } }
      | undefined;

    expect(content?.clientContent.turnComplete).toBe(true);
    // The id is the server's, echoed back. The client cannot mint one.
    expect(content?.clientContent.turns[0]?.parts[0]?.text).toContain("utt-turn-7");
  });

  /**
   * Why requestSpeech is safe to exist at all.
   *
   * It carries no wording. A tampered client calling it unprompted produces a
   * model that asks the tool surface for a probe and is refused server-side — a
   * wasted round trip, not an invented interview turn.
   */
  it("sends no scenario wording when asking the model to speak", () => {
    const h = build();
    h.voice.requestSpeech({ action: "ASK_PROBE", utteranceId: "utt-1" });

    const wire = JSON.stringify(h.sent);
    expect(wire).toContain("get_probe_wording");
    expect(wire).not.toMatch(/duplicate|scanner|conveyor/i);
  });

  it("does nothing when asked to speak before the session is ready", () => {
    const sent: Array<Record<string, unknown>> = [];
    let handlers!: RealtimeTransportHandlers;
    const voice = new RealtimeVoice({
      credential: CREDENTIAL,
      captureRate: 48_000,
      connect: (h) => {
        handlers = h;
        return { send: (d) => sent.push(JSON.parse(d)), close: () => {}, connected: true };
      },
    });

    voice.connect();
    handlers.onOpen();
    voice.requestSpeech({ action: "ASK_PROBE", utteranceId: "utt-1" });

    expect(JSON.stringify(sent)).not.toContain("clientContent");
  });

  it("refuses a credential that does not disable automatic activity detection", () => {
    // Cannot be minted by M3-1, so this guards a hand-built or tampered one.
    // Failing loudly beats opening a session that might answer on its own.
    expect(
      () =>
        new RealtimeVoice({
          credential: { ...CREDENTIAL, automaticActivityDetectionDisabled: false as true },
          captureRate: 48_000,
          connect: () => ({ send: () => {}, close: () => {}, connected: true }),
        }).connect(),
    ).toThrow(/automatic activity detection/i);
  });
});

describe("setup", () => {
  it("sends only the model, leaving the credential's constraints to win", () => {
    const h = build();
    const setup = h.sent.find((m) => m["setup"]) as { setup: Record<string, unknown> };

    expect(setup.setup).toEqual({ model: "models/gemini-live" });
  });

  it("is not ready until setupComplete arrives", () => {
    const sent: Array<Record<string, unknown>> = [];
    let handlers!: RealtimeTransportHandlers;

    const voice = new RealtimeVoice({
      credential: CREDENTIAL,
      captureRate: 48_000,
      connect: (h) => {
        handlers = h;
        return { send: (d) => sent.push(JSON.parse(d)), close: () => {}, connected: true };
      },
    });

    voice.connect();
    handlers.onOpen();
    expect(voice.isReady).toBe(false);

    handlers.onMessage(JSON.stringify({ setupComplete: {} }));
    expect(voice.isReady).toBe(true);
  });
});

describe("speech boundaries", () => {
  it("reports a turn start and end from the VAD, not from the transport", () => {
    const h = build();
    h.speak(400);
    h.quiet(900);

    expect(h.boundaries.map((b) => b.type)).toEqual(["SPEECH_STARTED", "SPEECH_STOPPED"]);
  });

  it("sends matching activity signals so the model knows the boundary", () => {
    const h = build();
    h.speak(400);
    h.quiet(900);

    const activity = h.sent
      .map((m) => m["realtimeInput"] as Record<string, unknown> | undefined)
      .filter((r): r is Record<string, unknown> => Boolean(r))
      .flatMap((r) => Object.keys(r))
      .filter((k) => k.startsWith("activity"));

    expect(activity).toEqual(["activityStart", "activityEnd"]);
  });

  /**
   * These are the events M4-2 measures silenceMs between. Reporting detection
   * time rather than onset would shorten every measured pause and make the gate
   * more willing to speak.
   */
  it("carries the VAD's onset timestamps", () => {
    const h = build();
    const startedAt = h.clock();
    h.speak(400);
    h.quiet(900);

    const stopped = h.boundaries.find((b) => b.type === "SPEECH_STOPPED");
    expect(stopped?.atMs).toBe(startedAt + 400);
  });
});

describe("barge-in", () => {
  it("fires the moment the candidate speaks over model audio", () => {
    const h = build();
    h.receive({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: pcm16ToBase64(new Int16Array(160)) } }] },
      },
    });

    expect(h.bargeIns).toBe(0);
    h.speak(400);
    expect(h.bargeIns).toBe(1);
  });

  it("does not fire when the interviewer is not speaking", () => {
    const h = build();
    h.speak(400);
    expect(h.bargeIns).toBe(0);
  });

  it("stops applying once the interviewer's turn is complete", () => {
    const h = build();
    h.receive({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm", data: pcm16ToBase64(new Int16Array(160)) } }] },
      },
    });
    h.receive({ serverContent: { turnComplete: true } });

    h.speak(400);
    expect(h.bargeIns).toBe(0);
  });
});

describe("model audio", () => {
  it("decodes inline audio parts", () => {
    const h = build();
    const pcm = new Int16Array([1, -1, 32767, -32768]);

    h.receive({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcm16ToBase64(pcm) } }] },
      },
    });

    expect(h.audio).toHaveLength(1);
    expect(Array.from(h.audio[0]!)).toEqual(Array.from(pcm));
  });

  it("ignores non-audio parts", () => {
    const h = build();
    h.receive({ serverContent: { modelTurn: { parts: [{ text: "hello" }] } } });
    expect(h.audio).toHaveLength(0);
  });

  it("reads snake_case as well as camelCase", () => {
    const h = build();
    const pcm = new Int16Array([7, 8]);

    h.receive({
      server_content: {
        model_turn: { parts: [{ inline_data: { mime_type: "audio/pcm", data: pcm16ToBase64(pcm) } }] },
      },
    });

    expect(Array.from(h.audio[0] ?? [])).toEqual([7, 8]);
  });
});

describe("mute and teardown", () => {
  it("closes an open turn on mute, so it cannot hang forever", () => {
    const h = build();
    h.speak(400);
    expect(h.boundaries.map((b) => b.type)).toEqual(["SPEECH_STARTED"]);

    h.voice.setMuted(true);
    expect(h.boundaries.map((b) => b.type)).toEqual(["SPEECH_STARTED", "SPEECH_STOPPED"]);
  });

  it("stops sending audio while muted", () => {
    const h = build();
    h.voice.setMuted(true);
    const before = h.sent.length;
    h.speak(400);

    expect(h.sent.length).toBe(before);
  });

  it("closes an open turn on disconnect", () => {
    const h = build();
    h.speak(400);
    h.voice.disconnect();

    // A session that vanishes mid-sentence must not leave the server believing
    // the candidate is still talking — the gate would hold the floor forever.
    expect(h.boundaries.at(-1)?.type).toBe("SPEECH_STOPPED");
  });
});

describe("degradation", () => {
  it("survives an unparseable frame rather than dropping the channel", () => {
    const h = build();
    h.handlers.onMessage("not json{");
    expect(h.errors).toHaveLength(0);

    h.speak(400);
    expect(h.boundaries.map((b) => b.type)).toEqual(["SPEECH_STARTED"]);
  });

  it("surfaces a server error without throwing", () => {
    const h = build();
    h.receive({ error: { code: 1011, message: "unavailable" } });

    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.message).toContain("1011");
  });
});

describe("tool calls are relayed, never answered here", () => {
  /**
   * The five tools read pinned scenario content and check the gate's
   * authorization. Neither may live in a browser the candidate controls, so the
   * client forwards the call and returns whatever the server says.
   */
  it("forwards a tool call and returns the server's answer", async () => {
    const relayed: VoiceToolCall[] = [];
    const h = build({
      callTool: async (call) => {
        relayed.push(call);
        return { ok: true, data: { wording: "why that complexity?" } };
      },
    });

    h.receive({ toolCall: { functionCalls: [{ id: "c1", name: "get_probe_wording", args: {} }] } });
    await new Promise((r) => setTimeout(r, 10));

    expect(relayed).toEqual([{ id: "c1", name: "get_probe_wording", args: {} }]);

    const response = h.sent.find((m) => m["toolResponse"]) as
      | { toolResponse: { functionResponses: Array<{ id: string; response: unknown }> } }
      | undefined;
    expect(response?.toolResponse.functionResponses[0]?.id).toBe("c1");
  });

  it("answers with a refusal when the relay fails, rather than stalling the turn", async () => {
    const h = build({
      callTool: async () => {
        throw new Error("network");
      },
    });

    h.receive({ toolCall: { functionCalls: [{ id: "c1", name: "get_probe_wording", args: {} }] } });
    await new Promise((r) => setTimeout(r, 10));

    // A model left waiting on a function response stalls, and a stalled turn is
    // indistinguishable from the interviewer choosing to say nothing.
    expect(JSON.stringify(h.sent.find((m) => m["toolResponse"]))).toContain("RELAY_FAILED");
  });

  it("never answers a tool call locally when no relay is wired", async () => {
    const h = build();
    h.receive({ toolCall: { functionCalls: [{ id: "c1", name: "get_probe_wording", args: {} }] } });
    await new Promise((r) => setTimeout(r, 10));

    // Refusing beats inventing. A client-side answer would bypass every check
    // the tool surface exists to perform.
    expect(JSON.stringify(h.sent.find((m) => m["toolResponse"]))).toContain("NO_RELAY");
  });
});
