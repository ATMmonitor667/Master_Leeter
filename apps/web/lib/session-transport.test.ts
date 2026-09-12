import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("./auth", () => ({ apiFetch }));
import { connectSessionTransport } from "./session-transport";

class FakeSocket {
  static OPEN = 1;
  static created: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  constructor(readonly url: string) { FakeSocket.created.push(this); }
  close() { this.readyState = 3; this.onclose?.(); }
}
const handlers = () => ({ onOpen: vi.fn(), onClose: vi.fn(), onMessage: vi.fn() });
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => { vi.clearAllMocks(); FakeSocket.created = []; vi.stubGlobal("WebSocket", FakeSocket); vi.stubEnv("NEXT_PUBLIC_WS_URL", "wss://api.example.com"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("authenticated editor connections", () => {
  it("obtains a fresh ticket for every reconnect and exposes readiness to the outbox", async () => {
    apiFetch.mockImplementation(async () => new Response(JSON.stringify({ ticket: `ticket-${apiFetch.mock.calls.length}` })));
    const h = handlers();
    const first = connectSessionTransport("room", h);
    expect(first.connected).toBe(false);
    await drain();
    const socket = FakeSocket.created[0]!;
    expect(socket.url).toBe("wss://api.example.com/v1/interview-sessions/room/events?ticket=ticket-1");
    socket.readyState = 1; socket.onopen?.();
    expect(first.connected).toBe(true);
    first.send("pending code"); expect(socket.send).toHaveBeenCalledWith("pending code");
    first.close();
    const second = connectSessionTransport("room", handlers());
    await drain();
    expect(FakeSocket.created[1]!.url).toContain("ticket=ticket-2");
    expect(h.onClose).not.toHaveBeenCalled();
    second.close();
  });
  it("does not open a socket if the page unmounts during ticket retrieval", async () => {
    let release!: (value: Response) => void;
    apiFetch.mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
    const h = handlers();
    const connection = connectSessionTransport("room", h);
    connection.close();
    release(new Response(JSON.stringify({ ticket: "late" })));
    await drain();
    expect(FakeSocket.created).toHaveLength(0);
    expect(h.onClose).not.toHaveBeenCalled();
  });
  it("reports failed authentication and lets the client retry without opening a socket", async () => {
    apiFetch.mockRejectedValue(new Error("Please sign in to continue."));
    const h = handlers(); const error = vi.fn();
    connectSessionTransport("room", h, error);
    await drain();
    expect(error).toHaveBeenCalledWith("Please sign in to continue.");
    expect(h.onClose).toHaveBeenCalledOnce();
    expect(FakeSocket.created).toHaveLength(0);
  });
});
