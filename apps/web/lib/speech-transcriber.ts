/**
 * Browser speech-to-text via the Web Speech API.
 *
 * Accessibility captions for what the candidate says — not a chat transcript of
 * the interviewer. Kept outside React so it can be tested with a fake recognizer.
 */

export type SpeechTranscriberStatus = "IDLE" | "LISTENING" | "UNSUPPORTED" | "ERROR";

export interface SpeechTranscriberCallbacks {
  onStatus?: (status: SpeechTranscriberStatus) => void;
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
}

/** Minimal surface of SpeechRecognition we depend on. */
export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface SpeechRecognitionResultLike extends ArrayLike<{ transcript: string }> {
  isFinal?: boolean;
}

export interface SpeechRecognitionResultEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

export interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

export interface SpeechTranscriberOptions extends SpeechTranscriberCallbacks {
  lang?: string;
  createRecognition?: () => SpeechRecognitionLike | null;
}

type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

export function speechRecognitionAvailable(win: SpeechWindow = window as SpeechWindow): boolean {
  return Boolean(win.SpeechRecognition ?? win.webkitSpeechRecognition);
}

function defaultCreateRecognition(): SpeechRecognitionLike | null {
  const win = window as SpeechWindow;
  const Ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  if (!Ctor) return null;
  return new Ctor();
}

export class SpeechTranscriber {
  private recognition: SpeechRecognitionLike | null = null;
  private status: SpeechTranscriberStatus = "IDLE";
  private readonly createRecognition: () => SpeechRecognitionLike | null;
  private readonly lang: string;

  constructor(private readonly opts: SpeechTranscriberOptions = {}) {
    this.createRecognition = opts.createRecognition ?? defaultCreateRecognition;
    this.lang = opts.lang ?? "en-US";
  }

  get currentStatus(): SpeechTranscriberStatus {
    return this.status;
  }

  start(): void {
    if (this.status === "LISTENING") return;

    const recognition = this.createRecognition();
    if (!recognition) {
      this.setStatus("UNSUPPORTED");
      this.opts.onError?.("Speech recognition is not supported in this browser.");
      return;
    }

    this.recognition = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.lang;

    recognition.onstart = () => {
      this.setStatus("LISTENING");
    };

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const text = result[0]?.transcript?.trim() ?? "";
        if (!text) continue;
        if (result.isFinal) {
          this.opts.onFinal?.(text);
        } else {
          interim = text;
        }
      }
      this.opts.onInterim?.(interim);
    };

    recognition.onerror = (event) => {
      if (event.error === "aborted" || event.error === "no-speech") return;
      this.setStatus("ERROR");
      this.opts.onError?.(event.error);
    };

    recognition.onend = () => {
      if (this.status === "LISTENING") {
        // Chrome stops after silence; restart while the user still wants captions.
        try {
          recognition.start();
        } catch {
          this.setStatus("IDLE");
        }
      }
    };

    try {
      recognition.start();
    } catch (err) {
      this.setStatus("ERROR");
      this.opts.onError?.(err instanceof Error ? err.message : "Failed to start speech recognition.");
    }
  }

  stop(): void {
    this.recognition?.abort();
    this.recognition = null;
    this.opts.onInterim?.("");
    if (this.status !== "UNSUPPORTED") this.setStatus("IDLE");
  }

  private setStatus(status: SpeechTranscriberStatus): void {
    this.status = status;
    this.opts.onStatus?.(status);
  }
}
