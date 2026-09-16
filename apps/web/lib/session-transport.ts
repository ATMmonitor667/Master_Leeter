import { apiFetch, SignInRequired } from "./auth";
import { webSocketBaseUrl } from "./public-config";
import type { Transport, TransportHandlers } from "./session-client";

/** Obtain a new one-use ticket for every connection, including retries. */
export function connectSessionTransport(sessionId: string, handlers: TransportHandlers, onError?: (message: string) => void): Transport {
  let socket: WebSocket | null = null;
  let closed = false;
  let reportedClose = false;
  const reportClose = (retryable = true) => {
    if (reportedClose || closed) return;
    reportedClose = true;
    handlers.onClose(retryable);
  };
  void (async () => {
    try {
      const response = await apiFetch(`/v1/interview-sessions/${sessionId}/socket-ticket`, { method: "POST" });
      if (!response.ok) {
        if ([401, 403, 404, 409].includes(response.status)) {
          if (!closed) onError?.("This interview is unavailable. Return home or sign in again to continue.");
          reportClose(false);
          return;
        }
        throw new Error("Could not connect to this interview. Retrying…");
      }
      const body: unknown = await response.json();
      if (closed) return;
      if (!body || typeof body !== "object" || !("ticket" in body) || typeof body.ticket !== "string") throw new Error("Invalid connection response");
      const base = webSocketBaseUrl();
      const url = new URL(`/v1/interview-sessions/${sessionId}/events`, base);
      url.searchParams.set("ticket", body.ticket);
      socket = new WebSocket(url.toString());
      socket.onopen = () => { if (!closed) handlers.onOpen(); };
      socket.onmessage = (event) => { if (!closed) handlers.onMessage(String(event.data)); };
      socket.onerror = () => { if (!closed) onError?.("Interview connection interrupted. Reconnecting…"); };
      socket.onclose = () => {
        if (!closed) void apiFetch(`/v1/interview-sessions/${sessionId}/disconnected`, { method: "POST", keepalive: true }).catch(() => {});
        reportClose();
      };
    } catch (error) {
      if (!closed) onError?.((error as Error).message);
      reportClose(!(error instanceof SignInRequired));
    }
  })();
  return {
    send: (data) => { if (socket?.readyState === WebSocket.OPEN && !closed) socket.send(data); },
    close: () => { closed = true; socket?.close(); },
    get connected() { return !closed && socket?.readyState === WebSocket.OPEN; },
  };
}
