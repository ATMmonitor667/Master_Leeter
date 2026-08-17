import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTENT_ROOT, buildServer } from "../../index.js";
import { loadScenarioLibrary, scenarioRef } from "../scenario/loader.js";
import type { LoadedScenario } from "../scenario/loader.js";

/**
 * M3-5 — the seam between an authorized decision and words being spoken.
 *
 * Driven over the real HTTP surface and a real socket, because the property
 * under test is reachability: the tool surface was already correct and already
 * unreachable from the voice agent, which is the failure this codebase produces
 * most often.
 */

let library: Map<string, LoadedScenario>;

interface Handle {
  app: ReturnType<typeof buildServer>;
  port: number;
}

const servers: Handle[] = [];

beforeAll(async () => {
  library = await loadScenarioLibrary(CONTENT_ROOT);
});

afterAll(async () => {
  await Promise.all(servers.map((s) => s.app.close()));
});

async function start(): Promise<Handle> {
  const app = buildServer({ library });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const handle: Handle = { app, port };
  servers.push(handle);
  return handle;
}

async function newSession(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/interview-sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `vr-${Math.random()}` },
    body: JSON.stringify({ scenarioRef: scenarioRef("conveyor-rescan@1") }),
  });
  return ((await res.json()) as { sessionId: string }).sessionId;
}

const callTool = (port: number, id: string, name: string, args: Record<string, unknown> = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/interview-sessions/${id}/voice-tool`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, args }),
  });

/** Opens a socket and speaks one finalized turn, collecting server messages. */
async function speak(port: number, sessionId: string, transcript: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/interview-sessions/${sessionId}/events`);
  const messages: Array<Record<string, unknown>> = [];

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.on("message", (raw) => messages.push(JSON.parse(String(raw)) as Record<string, unknown>));

  socket.send(
    JSON.stringify({
      sessionId,
      clientSeq: 0,
      idempotencyKey: `sp-${Math.random()}`,
      type: "SPEECH_FINAL",
      occurredAt: new Date().toISOString(),
      payload: { transcript, finalized: true },
    }),
  );

  await new Promise((r) => setTimeout(r, 250));
  socket.close();
  return messages;
}

describe("the voice agent can reach the tool surface", () => {
  it("relays a call and answers it", async () => {
    const { port } = await start();
    const id = await newSession(port);

    // A turn is needed first: the relay refuses when no orchestrator is live,
    // because there would be no authorization to check against.
    await speak(port, id, "is the list sorted");

    const res = await callTool(port, id, "get_interview_context");
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it("refuses an unknown tool rather than reaching anything", async () => {
    const { port } = await start();
    const id = await newSession(port);
    await speak(port, id, "is the list sorted");

    const body = (await (await callTool(port, id, "get_hidden_tests")).json()) as {
      ok: boolean;
      refusal: string;
    };

    expect(body).toMatchObject({ ok: false, refusal: "UNKNOWN_TOOL" });
  });

  /**
   * The load-bearing one. The tool surface checks the gate's authorization, and
   * that check is only worth anything if the browser cannot supply the answer
   * itself — which is why the relay exists rather than the client answering.
   */
  it("refuses probe wording that the gate never authorized", async () => {
    const { port } = await start();
    const id = await newSession(port);
    await speak(port, id, "I think I'll use a set here");

    const body = (await (await callTool(port, id, "get_probe_wording")).json()) as {
      ok: boolean;
      refusal: string;
    };

    expect(body.ok).toBe(false);
    // Either guard is a correct answer, and which one fires depends on how far
    // the interview has got. A fresh session sits in ORAL_PROBLEM_DELIVERY,
    // where the stage forbids probing outright — so the belt-and-braces check
    // lands before the gate check ever runs.
    expect(["STAGE_FORBIDS", "NOT_AUTHORIZED"]).toContain(body.refusal);
  });

  it("refuses when no orchestrator is live for the session", async () => {
    const { port } = await start();
    const id = await newSession(port);

    // Nothing has happened in this session yet, so there is no authorization to
    // check. An unchecked tool call is the thing this surface exists to prevent.
    const res = await callTool(port, id, "get_interview_context");
    expect(res.status).toBe(409);
  });

  it("404s an unknown session", async () => {
    const { port } = await start();
    const res = await callTool(port, "00000000-0000-4000-8000-00000000dead", "get_interview_context");
    expect(res.status).toBe(404);
  });

  it("answers a refusal with 200, so the model can read it and carry on", async () => {
    const { port } = await start();
    const id = await newSession(port);
    await speak(port, id, "hello");

    // A 4xx would look like a transport fault to the relay and get retried.
    const res = await callTool(port, id, "get_follow_up");
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: false });
  });
});

describe("the app channel never carries the words", () => {
  /**
   * Invariant 2 at the transport boundary.
   *
   * The client is told THAT the interviewer may speak, never what it will say —
   * probe variants, hint text and canonical facts are authored scenario content,
   * and a candidate reading them off the socket has read ahead.
   */
  it("pushes an ACTION with no wording in it", async () => {
    const { port } = await start();
    const id = await newSession(port);

    const messages = await speak(port, id, "can the list be empty");
    const actions = messages.filter((m) => m["kind"] === "ACTION");

    // An ACTION carries the action kind and an utterance id, and nothing else.
    // The earlier version of this compared the key list against a slice of a
    // fixed list by length, which passes for any shape of the right size — a
    // test that cannot fail is worse than no test, because it is trusted.
    expect(actions.length, "no ACTION was pushed for an authorized turn").toBeGreaterThan(0);

    for (const action of actions) {
      const keys = Object.keys(action).sort();
      expect(keys).toEqual(["action", "kind", "utteranceId"]);
      expect(JSON.stringify(action)).not.toMatch(/duplicate|sorted|scanner|package/i);
    }
  });

  it("never puts scenario content on the socket at all", async () => {
    const { port } = await start();
    const id = await newSession(port);

    const messages = await speak(port, id, "can the list be empty");
    const wire = JSON.stringify(messages);

    const scenario = library.get("conveyor-rescan@1")!;
    for (const secret of [
      scenario.version.oralBrief.openingScript.slice(0, 40),
      ...scenario.version.facts.map((f) => f.value),
      ...scenario.version.hintLadder.map((h) => h.text),
    ]) {
      expect(wire).not.toContain(secret);
    }
  });
});

describe("the authorization survives long enough to be used", () => {
  /**
   * The bug this test was written to expose.
   *
   * `deliver` pushed ACTION to the client and then immediately called
   * markSpeechFinished, which clears the authorization. By the time the browser
   * asked the model to speak and the model called a tool, the window had already
   * shut — so the interviewer could never fetch its own words and every voice
   * turn died as NOT_AUTHORIZED.
   *
   * Opening the interview is the easiest case to observe: a brand new session's
   * first event authorizes DELIVER_BRIEF unconditionally.
   */
  it("is still open when the voice agent calls a tool", async () => {
    const { port } = await start();
    const id = await newSession(port);

    await speak(port, id, "hello");

    const body = (await (await callTool(port, id, "get_interview_context")).json()) as {
      ok: boolean;
      data: Record<string, unknown>;
    };

    expect(body.ok).toBe(true);
    expect(
      body.data["authorizedAction"],
      "the authorization was closed before the voice agent could use it",
    ).not.toBe("STAY_SILENT");
  });
});

describe("the interview actually opens", () => {
  /**
   * SESSION_STARTED was appended at creation and never dispatched, so the whole
   * brief-delivery path was unreachable. The problem only got delivered if the
   * candidate spoke first — backwards, since they are waiting to hear it.
   */
  it("delivers the brief when the voice session reports ready", async () => {
    const { port } = await start();
    const id = await newSession(port);

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/interview-sessions/${id}/voice-ready`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));

    const events = await fetch(`http://127.0.0.1:${port}/v1/privacy/sessions/${id}/export`)
      .then((r) => r.json() as Promise<{ events: Array<{ type: string }> }>)
      .then((b) => b.events.map((e) => e.type));

    expect(events, "the interview never opened").toContain("BRIEF_DELIVERED");
  });

  it("does not deliver it twice when the client retries", async () => {
    const { port } = await start();
    const id = await newSession(port);

    for (let i = 0; i < 3; i++) {
      await fetch(`http://127.0.0.1:${port}/v1/interview-sessions/${id}/voice-ready`, {
        method: "POST",
      });
    }
    await new Promise((r) => setTimeout(r, 100));

    const events = await fetch(`http://127.0.0.1:${port}/v1/privacy/sessions/${id}/export`)
      .then((r) => r.json() as Promise<{ events: Array<{ type: string }> }>)
      .then((b) => b.events.filter((e) => e.type === "BRIEF_DELIVERED"));

    expect(events).toHaveLength(1);
  });
});
