import type { ClientEvent, ServerMessage } from "@master-leeter/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionClient, type Transport, type TransportHandlers } from "./session-client";

/**
 * Reconnect correctness is the hardest part of this client, so it is tested
 * without React, without sockets, and without real timers.
 */

class FakeTransport implements Transport {
  sent: string[] = [];
  connected = true;
  constructor(readonly handlers: TransportHandlers) {}

  send(data: string): void {
    if (!this.connected) return;
    this.sent.push(data);
  }
  close(): void {
    this.connected = false;
  }

  drop(): void {
    this.connected = false;
    this.handlers.onClose();
  }
  restore(): void {
    this.connected = true;
    this.handlers.onOpen();
  }
  deliver(msg: ServerMessage): void {
    this.handlers.onMessage(JSON.stringify(msg));
  }
  get events(): ClientEvent[] {
    return this.sent.map((s) => JSON.parse(s) as ClientEvent);
  }
}

const SESSION = "00000000-0000-4000-8000-000000000001";

function build(debounceMs = 500) {
  let transport: FakeTransport | null = null;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const received: ServerMessage[] = [];

  const client = new SessionClient({
    sessionId: SESSION,
    debounceMs,
    now: () => 1_754_000_000_000,
    newId: (() => {
      let n = 0;
      return () => `key-${n++}`;
    })(),
    setTimer: (fn) => {
      const id = timerId++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (h) => timers.delete(h as number),
    connect: (handlers) => {
      transport = new FakeTransport(handlers);
      return transport;
    },
    onServerMessage: (m) => received.push(m),
  });

  client.connect();

  return {
    client,
    received,
    get transport() {
      if (!transport) throw new Error("not connected");
      return transport;
    },
    /** Fires every scheduled timer, simulating the candidate pausing. */
    tick() {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
    },
    get pendingTimers() {
      return timers.size;
    },
  };
}

describe("debouncing", () => {
  let h: ReturnType<typeof build>;

  beforeEach(() => {
    h = build();
  });

  it("sends nothing while the candidate is still typing", () => {
    for (const text of ["d", "de", "def", "def "]) h.client.codeChanged(text);
    expect(h.transport.sent).toHaveLength(0);
  });

  it("collapses a burst of keystrokes into one delta", () => {
    for (const text of ["d", "de", "def", "def f", "def foo():"]) h.client.codeChanged(text);
    h.tick();

    expect(h.transport.events).toHaveLength(1);
    expect(h.transport.events[0]?.payload["text"]).toBe("def foo():");
  });

  it("keeps only one timer alive across a burst", () => {
    for (const text of ["a", "ab", "abc"]) h.client.codeChanged(text);
    expect(h.pendingTimers).toBe(1);
  });

  it("sends nothing at all when the candidate never types", () => {
    h.tick();
    expect(h.transport.sent).toHaveLength(0);
  });
});

describe("revisions", () => {
  it("increments only when a delta actually ships", () => {
    const h = build();
    expect(h.client.revision).toBe(0);

    h.client.codeChanged("a");
    h.client.codeChanged("ab");
    // Still buffered — nothing has been sent, so no revision exists yet.
    expect(h.client.revision).toBe(0);

    h.tick();
    expect(h.client.revision).toBe(1);
  });

  it("is monotonic across many flushes", () => {
    const h = build();
    for (let i = 0; i < 5; i++) {
      h.client.codeChanged(`v${i}`);
      h.tick();
    }
    expect(h.client.revision).toBe(5);
    expect(h.transport.events.map((e) => e.payload["revision"])).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not advance on a flush with nothing pending", () => {
    const h = build();
    h.client.codeChanged("a");
    h.tick();
    h.tick();
    expect(h.client.revision).toBe(1);
  });
});

describe("runs", () => {
  it("flushes pending code before requesting a run", () => {
    const h = build();
    h.client.codeChanged("print(1)");
    const revision = h.client.requestRun("");

    const types = h.transport.events.map((e) => e.type);
    expect(types).toEqual(["CODE_DELTA", "RUN_REQUESTED"]);
    // A run against a revision the server has not seen would be unattributable.
    expect(revision).toBe(1);
    expect(h.transport.events[1]?.payload["revision"]).toBe(1);
  });

  it("carries the custom input", () => {
    const h = build();
    h.client.requestRun("A7 B2 A7");
    expect(h.transport.events[0]?.payload["input"]).toBe("A7 B2 A7");
  });
});

describe("notes", () => {
  it("emits note activity without touching the code revision", () => {
    const h = build();
    h.client.notesChanged("duplicates allowed");
    h.tick();

    expect(h.transport.events[0]?.type).toBe("NOTE_DELTA");
    expect(h.client.revision).toBe(0);
  });

  it("ships code and notes together when both are pending", () => {
    const h = build();
    h.client.codeChanged("x = 1");
    h.client.notesChanged("n log n?");
    h.tick();

    expect(h.transport.events.map((e) => e.type)).toEqual(["CODE_DELTA", "NOTE_DELTA"]);
  });
});

describe("sequencing and acks", () => {
  it("numbers events consecutively from zero", () => {
    const h = build();
    for (let i = 0; i < 3; i++) {
      h.client.codeChanged(`v${i}`);
      h.tick();
    }
    expect(h.transport.events.map((e) => e.clientSeq)).toEqual([0, 1, 2]);
  });

  it("gives every event a unique idempotency key", () => {
    const h = build();
    for (let i = 0; i < 4; i++) {
      h.client.codeChanged(`v${i}`);
      h.tick();
    }
    const keys = h.transport.events.map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("clears an event from the outbox once acked", () => {
    const h = build();
    h.client.codeChanged("a");
    h.tick();
    expect(h.client.pendingCount).toBe(1);

    h.transport.deliver({ kind: "ACK", clientSeq: 0, seq: 0 });
    expect(h.client.pendingCount).toBe(0);
  });

  it("tracks the resume point from server sequence numbers", () => {
    const h = build();
    h.client.codeChanged("a");
    h.tick();
    h.transport.deliver({ kind: "ACK", clientSeq: 0, seq: 7 });
    expect(h.client.resumeFrom).toBe(7);
  });
});

describe("surviving a dropped connection", () => {
  it("holds unacked events rather than losing them", () => {
    const h = build();
    h.client.codeChanged("before drop");
    h.tick();
    h.transport.drop();

    h.client.codeChanged("during outage");
    h.tick();

    // Two events buffered, nothing lost, nothing sent into the void.
    expect(h.client.pendingCount).toBe(2);
    expect(h.transport.sent).toHaveLength(1);
  });

  it("resends everything unacked on reconnect, oldest first", () => {
    const h = build();
    h.client.codeChanged("a");
    h.tick();
    h.transport.deliver({ kind: "ACK", clientSeq: 0, seq: 0 });

    h.transport.drop();
    h.client.codeChanged("b");
    h.tick();
    h.client.codeChanged("c");
    h.tick();

    h.transport.restore();

    const resent = h.transport.events.slice(1);
    // The acked event is not resent; the two unacked ones are, in order.
    expect(resent.map((e) => e.clientSeq)).toEqual([1, 2]);
  });

  it("replays from the requested point when the server reports a gap", () => {
    const h = build();
    for (let i = 0; i < 4; i++) {
      h.client.codeChanged(`v${i}`);
      h.tick();
    }
    const before = h.transport.sent.length;

    h.transport.deliver({ kind: "REPLAY_FROM", seq: 2 });

    const replayed = h.transport.events.slice(before);
    expect(replayed.map((e) => e.clientSeq)).toEqual([2, 3]);
  });

  it("keeps idempotency keys stable across a resend so the server can dedupe", () => {
    const h = build();
    h.client.codeChanged("a");
    h.tick();
    const originalKey = h.transport.events[0]?.idempotencyKey;

    h.transport.drop();
    h.transport.restore();

    expect(h.transport.events[1]?.idempotencyKey).toBe(originalKey);
  });

  it("sends finalized speech transcripts", () => {
    const h = build();
    h.client.speechFinal("is the list sorted?");
    expect(h.transport.events[0]).toMatchObject({
      type: "SPEECH_FINAL",
      payload: { transcript: "is the list sorted?", finalized: true },
    });
    h.client.speechFinal("   ");
    expect(h.transport.events).toHaveLength(1);
  });
});

describe("robustness", () => {
  it("ignores malformed server messages instead of crashing", () => {
    const h = build();
    expect(() => h.transport.handlers.onMessage("not json")).not.toThrow();
  });

  it("forwards server messages to the UI", () => {
    const h = build();
    h.transport.deliver({
      kind: "STATE",
      state: "IMPLEMENTATION",
      remainingSeconds: 900,
      interviewerStatus: "LISTENING",
    });
    expect(h.received.at(-1)).toMatchObject({ kind: "STATE", state: "IMPLEMENTATION" });
  });

  it("cancels pending work on disconnect", () => {
    const h = build();
    h.client.codeChanged("a");
    h.client.disconnect();
    expect(h.pendingTimers).toBe(0);
  });

  it("does not re-dial after a deliberate disconnect", () => {
    // Leaving the page must not schedule a reconnect. Without the stopped flag
    // this leaks a timer that resurrects the socket after teardown.
    const h = build();
    h.client.disconnect();
    h.transport.handlers.onClose();
    expect(h.pendingTimers).toBe(0);
  });
});
