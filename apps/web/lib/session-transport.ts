import { apiFetch } from "./auth";
import type { Transport, TransportHandlers } from "./session-client";

/** Obtain a new one-use ticket for every connection, including retries. */
export function connectSessionTransport(sessionId: string, handlers: TransportHandlers, onError?: (message: string) => void): Transport {
  let socket: WebSocket | null = null;
  let closed = false;
  let reportedClose = false;
  const reportClose = () => {
    if (reportedClose || closed) return;
    reportedClose = true;
    handlers.onClose();
  };
  void (async () => {
    try {
      const response = await apiFetch(`/v1/interview-sessions/${sessionId}/socket-ticket`, { method: "POST" });
      if (!response.ok) throw new Error("Could not connect to this interview. Please retry or sign in again.");
      const body: unknown = await response.json();
      if (closed) return;
      if (!body || typeof body !== "object" || !("ticket" in body) || typeof body.ticket !== "string") throw new Error("Invalid connection response");
      const base = process.env["NEXT_PUBLIC_WS_URL"] ?? "ws://localhost:4000";
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
      reportClose();
    }
  })();
  return {
    send: (data) => { if (socket?.readyState === WebSocket.OPEN && !closed) socket.send(data); },
    close: () => { closed = true; socket?.close(); },
    get connected() { return !closed && socket?.readyState === WebSocket.OPEN; },
  };
}
