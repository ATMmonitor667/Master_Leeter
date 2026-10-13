import type { ChatInput, ChatReviewInput, ChatSnapshot } from "@master-leeter/contracts";
import { apiFetch } from "./api-client";

const errors: Record<string, string> = {
  CHAT_UNAVAILABLE: "The chat interviewer is not configured. Ask the administrator to enable the text model.",
  CHAT_PROVIDER_FAILED: "The interviewer couldn't respond. Your draft is still here; retry this submission.",
  CHAT_BUSY: "A response is already being prepared. Wait a moment, then retry.",
  CHAT_STALE_TURN: "This conversation changed in another tab. The latest messages have been loaded; review them before submitting again.",
  CHAT_REQUEST_CONFLICT: "This submission conflicts with a saved turn. Reload the conversation before trying again.",
  SESSION_ENDED: "This interview has ended. Your saved conversation is available to review.",
  NOT_CHAT_SESSION: "This session uses voice. Open it from interview history.",
  CHAT_TURN_LIMIT: "This conversation reached its message limit. Finish the interview to save it.",
  CHAT_NOT_STARTED: "The interview hasn't opened yet. Reload to receive the problem.",
  INVALID_CHAT_PHASE: "That action isn't available at this point in the interview.",
  INVALID_CHAT_INPUT: "That submission is empty or too long. Edit it and try again.",
  REVIEW_NOT_AVAILABLE: "The review opens after a coding interview ends.",
  REVIEW_UNAVAILABLE: "The review model is not configured. Ask the administrator to enable it.",
  CONFIRMED_RESUME_REQUIRED: "Resume context is unavailable. Start a new interview with confirmed resume facts.",
};
export class ChatRequestError extends Error {
  constructor(readonly code: string) { super(errors[code] ?? "Couldn't load the interview. Please retry."); }
}
export async function chatRequest(sessionId: string, action: "read" | "start" | "turn" | "review", input?: ChatInput | ChatReviewInput): Promise<ChatSnapshot> {
  const suffix = action === "start" ? "/start" : action === "turn" ? "/turns" : action === "review" ? "/review" : "";
  const response = await apiFetch(`/v1/interview-sessions/${sessionId}/chat${suffix}`, {
    method: action === "read" ? "GET" : "POST",
    ...(input ? { headers: { "content-type": "application/json" }, body: JSON.stringify(input) } : {}),
  });
  const body = await response.json();
  if (!response.ok) throw new ChatRequestError(body.error ?? "CHAT_FAILED");
  return body as ChatSnapshot;
}
