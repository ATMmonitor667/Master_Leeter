import type { SessionEvent, ServerMessage } from "@master-leeter/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { loadScenarioFile } from "../scenario/loader.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SessionChannel } from "./channel.js";
import { InMemoryEventLog } from "./event-log.js";
import { InMemorySessionStore } from "./session-store.js";
import { type SocketLike, handleConnection } from "./ws.js";

/**
 * The socket adapter, driven by a fake socket.
 *
 * The point of keeping this file thin was that its logic should be testable
 * without a network. These tests are the proof — if they ever need a real
 * server, the adapter has grown something that belongs in the channel.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = join(here, "../../../../../content/scenarios/conveyor-rescan/v1.yaml");

class FakeSocket implements SocketLike {
  readonly sent: ServerMessage[] = [];
  private readonly listeners = new Map<string, Array<(arg: unknown) => void>>();

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }

  on(event: "message", listener: (data: { toString(): string }) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: string, listener: (arg: never) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as (arg: unknown) => void);
    this.listeners.set(event, list);
  }

  /** Deliver a frame and let the handler's async work drain. */
  async deliver(frame: unknown): Promise<void> {
    const raw = typeof frame === "string" ? frame : JSON.stringify(frame);
    for (const l of this.listeners.get("message") ?? []) l(raw);
    await new Promise((resolve) => setImmediate(resolve));
  }

  close(): void {
    for (const l of this.listeners.get("close") ?? []) l(undefined);
  }

  kinds(): string[] {
    return this.sent.map((m) => m.kind);
  }
}

let log: InMemoryEventLog;
let store: InMemorySessionStore;
let channel: SessionChannel;
let dispatched: SessionEvent[];
let socket: FakeSocket;
let sessionId: string;

beforeEach(async () => {
  log = new InMemoryEventLog();
  store = new InMemorySessionStore();
  channel = new SessionChannel({ sessions: store, eventLog: log });
  dispatched = [];

  const scenario = await loadScenarioFile(SCENARIO_PATH);
  const session = await store.create({
    userId: "u1",
    scenario,
    mode: "MOCK",
    idempotencyKey: "k1",
  });
  sessionId = session.id;

  socket = new FakeSocket();
  handleConnection(socket, sessionId, {
    channel,
    dispatch: async (event) => {
      dispatched.push(event);
    },
  });
});

const clientEvent = (clientSeq: number, key: string, payload: Record<string, unknown> = {}) => ({
  sessionId,
  clientSeq,
  idempotencyKey: key,
  type: "CODE_DELTA" as const,
  occurredAt: "2026-08-09T00:00:00.000Z",
  payload: { revision: clientSeq, text: "x = 1", ...payload },
});

describe("framing", () => {
  it("acks a valid event and forwards it to the orchestrator", async () => {
    await socket.deliver(clientEvent(0, "e0"));

    expect(socket.kinds()).toEqual(["ACK"]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.type).toBe("CODE_DELTA");
  });

  it("survives an unparseable frame instead of dropping the connection", async () => {
    await socket.deliver("{not json");

    expect(socket.sent[0]).toMatchObject({ kind: "ERROR", code: "INVALID_JSON" });

    // Still usable — the candidate's editor channel is worth more than strictness.
    await socket.deliver(clientEvent(0, "e0"));
    expect(socket.kinds()).toEqual(["ERROR", "ACK"]);
  });

  it("reports a schema-invalid event without forwarding it", async () => {
    await socket.deliver({ sessionId, nonsense: true });

    expect(socket.sent[0]).toMatchObject({ kind: "ERROR" });
    expect(dispatched).toHaveLength(0);
  });
});

describe("duplicates and gaps reach the orchestrator correctly", () => {
  it("acks a replayed event but does not apply it twice", async () => {
    await socket.deliver(clientEvent(0, "e0"));
    await socket.deliver(clientEvent(0, "e0"));

    // Two ACKs — the client must not be able to tell, or blind retry is unsafe.
    expect(socket.kinds()).toEqual(["ACK", "ACK"]);
    // One application. Replaying a delta must not re-drive interview state.
    expect(dispatched).toHaveLength(1);
  });

  it("asks for replay on a gap and forwards nothing", async () => {
    await socket.deliver(clientEvent(0, "e0"));
    dispatched.length = 0;

    await socket.deliver(clientEvent(5, "e5"));

    expect(socket.sent.at(-1)).toMatchObject({ kind: "REPLAY_FROM", seq: 1 });
    expect(dispatched).toHaveLength(0);
  });
});

describe("close", () => {
  it("clears the sequence watermark so a reconnect is not read as a gap", async () => {
    await socket.deliver(clientEvent(0, "e0"));
    await socket.deliver(clientEvent(1, "e1"));

    socket.close();

    const reconnected = new FakeSocket();
    handleConnection(reconnected, sessionId, {
      channel,
      dispatch: async (event) => {
        dispatched.push(event);
      },
    });

    // A fresh connection starting from 0 again must not be told it has a hole.
    await reconnected.deliver(clientEvent(0, "e-new"));
    expect(reconnected.kinds()).toEqual(["ACK"]);
  });
});
