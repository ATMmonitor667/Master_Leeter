import { encodeForLive } from "../audio";
import { PlaybackScheduler, type AudioSink, type ScheduledSource } from "../playback";

/**
 * Microphone in, interviewer audio out.
 *
 * Capture: an AudioWorklet posts 20 ms frames, which are resampled to 16 kHz
 * PCM16 and handed straight to the provider (R6).
 * Playback: the provider's 24 kHz PCM is scheduled gaplessly, through an
 * analyser so the presence orb can react to what is actually audible. Nothing
 * here records or stores audio.
 */

const CAPTURE_WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(Math.round(sampleRate * 0.02));
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i];
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("capture", CaptureProcessor);
`;

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export interface AudioIOEvents {
  /** Base64 PCM16 at 16 kHz, one per 20 ms of microphone audio. */
  frame(base64: string): void;
  /** Interviewer audio started or stopped being audible. */
  playing(active: boolean): void;
  /** The microphone was unplugged or revoked. */
  microphoneLost(): void;
}

export class AudioIO {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private scheduler: PlaybackScheduler | null = null;
  private scratch = new Float32Array(512);
  private muted = false;
  /** Smoothed microphone level, 0..1. */
  inputLevel = 0;
  /** performance.now() of the last microphone frame loud enough to be speech. */
  lastVoiceAt = 0;

  constructor(private readonly events: AudioIOEvents) {}

  /** Must be called from a click: browsers only start audio on a user gesture. */
  async open(deviceId?: string): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      },
    });
    const context = new AudioContext({ latencyHint: "interactive" });
    await context.resume();
    this.stream = stream;
    this.context = context;
    for (const track of stream.getAudioTracks()) track.onended = () => this.events.microphoneLost();

    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "application/javascript" }));
    try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "capture");
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const level = rms(event.data);
      this.inputLevel = this.inputLevel * 0.7 + Math.min(1, level * 6) * 0.3;
      if (this.muted) return;
      if (level > 0.015) this.lastVoiceAt = performance.now();
      this.events.frame(encodeForLive(event.data, context.sampleRate));
    };
    source.connect(worklet);
    // Keeps the worklet in the render graph without making the mic audible.
    const silent = context.createGain();
    silent.gain.value = 0;
    worklet.connect(silent).connect(context.destination);

    const gain = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    gain.connect(analyser).connect(context.destination);
    this.analyser = analyser;

    const sink: AudioSink = {
      get currentTime() { return context.currentTime; },
      get running() { return context.state === "running"; },
      play: (samples, sampleRate, atTime) => {
        const buffer = context.createBuffer(1, samples.length, sampleRate);
        buffer.getChannelData(0).set(samples);
        const node = context.createBufferSource();
        node.buffer = buffer;
        node.connect(gain);
        const handle: ScheduledSource = { stop: () => node.stop() };
        node.onended = () => this.scheduler?.release(handle);
        node.start(atTime);
        return handle;
      },
    };
    this.scheduler = new PlaybackScheduler({ sink, onDrained: () => this.events.playing(false) });
  }

  play(pcm: Int16Array): void {
    if (!this.scheduler) return;
    const wasPlaying = this.scheduler.isPlaying;
    this.scheduler.enqueue(pcm);
    if (!wasPlaying) this.events.playing(true);
  }

  /** Stop everything queued, at once. Used when the candidate interrupts. */
  flush(): void {
    if (!this.scheduler?.isPlaying) return;
    this.scheduler.stop();
    this.events.playing(false);
  }

  get playing(): boolean { return this.scheduler?.isPlaying ?? false; }

  /** Level of what is audible right now, 0..1. Zero when nothing is playing. */
  outputLevel(): number {
    if (!this.analyser || !this.playing) return 0;
    this.analyser.getFloatTimeDomainData(this.scratch);
    return Math.min(1, rms(this.scratch) * 5);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  close(): void {
    this.scheduler?.stop();
    for (const track of this.stream?.getTracks() ?? []) { track.onended = null; track.stop(); }
    void this.context?.close().catch(() => {});
    this.stream = null;
    this.context = null;
    this.scheduler = null;
    this.analyser = null;
  }
}
