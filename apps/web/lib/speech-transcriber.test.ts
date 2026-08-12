import { describe, expect, it, vi } from "vitest";
import {
  SpeechTranscriber,
  type SpeechRecognitionLike,
  type SpeechRecognitionResultEventLike,
} from "./speech-transcriber";

class FakeRecognition implements SpeechRecognitionLike {
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null = null;

  start = vi.fn(() => this.onstart?.());
  stop = vi.fn();
  abort = vi.fn(() => this.onend?.());
}

describe("SpeechTranscriber", () => {
  it("reports unsupported when SpeechRecognition is missing", () => {
    const onStatus = vi.fn();
    const onError = vi.fn();
    const transcriber = new SpeechTranscriber({
      createRecognition: () => null,
      onStatus,
      onError,
    });

    transcriber.start();

    expect(onStatus).toHaveBeenCalledWith("UNSUPPORTED");
    expect(onError).toHaveBeenCalled();
  });

  it("emits interim and final transcripts", () => {
    const recognition = new FakeRecognition();
    const onInterim = vi.fn();
    const onFinal = vi.fn();

    const transcriber = new SpeechTranscriber({
      createRecognition: () => recognition,
      onInterim,
      onFinal,
    });

    transcriber.start();
    recognition.onresult?.({
      resultIndex: 0,
      results: [{ 0: { transcript: "hello " }, isFinal: false, length: 1 }],
    });
    expect(onInterim).toHaveBeenCalledWith("hello");

    recognition.onresult?.({
      resultIndex: 0,
      results: [{ 0: { transcript: "hello world" }, isFinal: true, length: 1 }],
    });
    expect(onFinal).toHaveBeenCalledWith("hello world");
  });

  it("stop clears interim text and returns to idle", () => {
    const recognition = new FakeRecognition();
    const onInterim = vi.fn();
    const onStatus = vi.fn();

    const transcriber = new SpeechTranscriber({
      createRecognition: () => recognition,
      onInterim,
      onStatus,
    });

    transcriber.start();
    transcriber.stop();

    expect(recognition.abort).toHaveBeenCalled();
    expect(onInterim).toHaveBeenLastCalledWith("");
    expect(onStatus).toHaveBeenCalledWith("IDLE");
  });
});
