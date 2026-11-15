import type { LiveCredential } from "@master-leeter/contracts";

/**
 * The one seam between the interview room and a realtime voice model.
 *
 * Rules for everything behind this interface (rebuild plan, section 6.2):
 *   R1 nothing sits between the microphone and the model except this connection
 *   R2 no tool calls on the speaking path: context is pushed with sendText
 *   R6 on "interrupted", local playback is cleared at once
 *
 * gemini-live.ts implements it over a WebSocket. A WebRTC provider would
 * implement the same surface with sendAudio as a no-op (the track carries audio).
 */
export interface LiveProviderEvents {
  /** PCM16 mono at 24 kHz. */
  audio(pcm: Int16Array): void;
  /** The model was cut off because the candidate started speaking. */
  interrupted(): void;
  /** A fragment of what the candidate said. Fragments append. */
  userText(fragment: string): void;
  /** A fragment of what the interviewer said. Fragments append. */
  modelText(fragment: string): void;
  /** The provider heard the candidate start or stop speaking. */
  speech(active: boolean): void;
  /** The interviewer finished a turn. */
  turnEnd(): void;
  /** The provider will close this connection in about `ms`. Reconnect before then. */
  goAway(ms: number): void;
  /** A handle that lets the next connection continue this conversation. */
  resumption(handle: string): void;
  /** The connection ended. `expected` is true only after close(). */
  closed(info: { code: number; reason: string; expected: boolean }): void;
}

export interface LiveProvider {
  /** Resolves once the provider is ready to hear audio. */
  connect(credential: LiveCredential): Promise<void>;
  /** Base64 PCM16 mono at 16 kHz. */
  sendAudio(base64Pcm16: string): void;
  /** The microphone was paused; lets the provider settle its turn detection. */
  pauseAudio(): void;
  /** respond: true asks for a spoken reply; false only adds context. */
  sendText(text: string, opts: { respond: boolean }): void;
  close(): void;
}
