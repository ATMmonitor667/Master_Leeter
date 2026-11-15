import type {
  ChatTurnInput, LiveCredential, LiveEvent, ReviewTurn, RoomSnapshot, RunReport, TranscriptEntry,
} from "@master-leeter/contracts";
import { apiFetch } from "./api-client";

/** Everything the interview room asks the API. None of it is on the speaking path. */

const MESSAGES: Record<string, string> = {
  SESSION_ENDED: "This interview has ended.",
  CHAT_BUSY: "A reply is already on its way. Wait a moment, then retry.",
  CHAT_PROVIDER_FAILED: "The interviewer couldn't respond. Your message is saved; retry to get the reply.",
  CHAT_UNAVAILABLE: "The chat interviewer is not configured on the server.",
  CHAT_TURN_LIMIT: "This conversation reached its length limit. Finish the interview to save it.",
  LIVE_UNAVAILABLE: "Voice is not configured on the server.",
  LIVE_RATE_LIMITED: "The voice provider is rate limiting. Retry in a minute.",
  RUNNER_UNAVAILABLE: "The code could not be run right now. The interviewer can still read it.",
  LEGACY_SESSION: "This interview was recorded before the rebuild and cannot be reopened. Its report is still available.",
  UNKNOWN_SESSION: "That interview does not exist.",
  REVIEW_NOT_AVAILABLE: "The review opens after the interview ends.",
  REVIEW_UNAVAILABLE: "The review model is not configured on the server.",
  REVIEW_PROVIDER_FAILED: "The review could not be generated. Retry in a moment.",
};

export class RoomError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? MESSAGES[code] ?? "Something went wrong. Please retry.");
    this.name = "RoomError";
  }
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!response.ok) throw new RoomError(body.error ?? `HTTP_${response.status}`, MESSAGES[body.error ?? ""] ?? body.message);
  return body as T;
}

const post = (path: string, body: unknown) =>
  apiFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const roomApi = {
  snapshot: async (id: string) => json<RoomSnapshot>(await apiFetch(`/v1/interview-sessions/${id}`)),
  mint: async (id: string, resumptionHandle?: string) =>
    json<LiveCredential>(await post(`/v1/interview-sessions/${id}/live`, resumptionHandle ? { resumptionHandle } : {})),
  upload: async (id: string, events: LiveEvent[]) => { await json(await post(`/v1/interview-sessions/${id}/events`, { events })); },
  run: async (id: string, source: string, revision: number) =>
    json<RunReport>(await post(`/v1/interview-sessions/${id}/runs`, { source, revision })),
  end: async (id: string) => { await json(await post(`/v1/interview-sessions/${id}/end`, {})); },
  review: async (id: string) =>
    json<{ turns: ReviewTurn[]; transcript: TranscriptEntry[]; available: boolean }>(await apiFetch(`/v1/interview-sessions/${id}/review`)),
  ask: async (id: string, requestId: string, question: string) =>
    json<{ turns: ReviewTurn[] }>(await post(`/v1/interview-sessions/${id}/review`, { requestId, question })),

  /** One chat turn. `onDelta` receives the reply as it streams. */
  async chat(id: string, input: ChatTurnInput, onDelta: (piece: string) => void): Promise<RoomSnapshot> {
    const response = await post(`/v1/interview-sessions/${id}/chat`, input);
    if (!response.ok || !response.body) return json<RoomSnapshot>(response);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let room: RoomSnapshot | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/^data: /, "");
        buffer = buffer.slice(end + 2);
        let event: { delta?: string; done?: boolean; room?: RoomSnapshot; error?: string };
        try { event = JSON.parse(line); } catch { continue; }
        if (event.error) throw new RoomError(event.error);
        if (event.delta) onDelta(event.delta);
        if (event.room) room = event.room;
      }
    }
    if (!room) throw new RoomError("CHAT_PROVIDER_FAILED");
    return room;
  },
};
