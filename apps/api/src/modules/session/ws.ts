import type { SessionEvent, ServerMessage } from "@master-leeter/contracts";
import type { FastifyInstance } from "fastify";
import type { SessionChannel } from "./channel.js";

/**
 * WebSocket adapter for the app channel (M2-2, transport half).
 *
 * Deliberately the thinnest file in the module. `SessionChannel` already owns
 * the protocol — dedupe, gap detection, replay, resume — and is tested without
 * a socket, because testing reconnect semantics through a real socket means
 * testing the socket. Everything here is framing: parse a frame, hand it to the
 * channel, write the replies, forward committed events to the orchestrator.
 *
 * If this file ever grows a policy decision, it belongs one layer down.
 */

/**
 * The parts of a WebSocket this adapter uses.
 *
 * Declared locally rather than imported from the plugin so the handler can be
 * unit-tested with a fake, and so this file does not depend on the plugin's
 * type augmentation of Fastify's route generics.
 */
export interface SocketLike {
  send(data: string): void;
  on(event: "message", listener: (data: { toString(): string }) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

export interface EventsSocketDeps {
  channel: SessionChannel;
  /** Called with each committed event so the orchestrator can apply it. */
  dispatch: (event: SessionEvent) => Promise<void>;
  /** Registers this socket to receive async server pushes (run results, etc.). */
  attach?: (sessionId: string, push: (msg: ServerMessage) => void) => () => void;
  log?: { warn(o: unknown, msg: string): void; error(o: unknown, msg: string): void };
}

/**
 * The connection handler, transport-free.
 *
 * Exported so tests can drive a fake socket through the real logic. Everything
 * interesting about this adapter lives here; `registerEventsSocket` only binds
 * it to a route.
 */
export function handleConnection(socket: SocketLike, sessionId: string, deps: EventsSocketDeps): void {
  const write = (messages: ServerMessage[]): void => {
    for (const message of messages) socket.send(JSON.stringify(message));
  };

  const detach = deps.attach?.(sessionId, (msg) => write([msg]));

  /**
   * Send the current state as soon as the socket opens.
   *
   * `SessionChannel.resume()` has always built this message and nothing ever
   * called it, so `STATE` reached no client: the timer counted down locally from
   * a single HTTP read and the interviewer indicator was frozen on LISTENING
   * forever. A refresh mid-interview re-synced the editor and not the clock.
   *
   * Failure is swallowed on purpose. A state snapshot is a convenience; losing
   * it must not cost the candidate the socket that carries their code.
   */
  void deps.channel
    .resume(sessionId, -1)
    .then((result) => write(result.messages.filter((m) => m.kind === "STATE")))
    .catch((err: unknown) => deps.log?.warn({ sessionId, err }, "initial state push failed"));

  socket.on("message", (raw) => {
    void (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        // A frame we cannot parse is not evidence of anything. Tell the client
        // and keep the connection — dropping the socket would cost the
        // candidate their editor channel over one bad frame.
        write([{ kind: "ERROR", code: "INVALID_JSON", message: "frame is not JSON" }]);
        return;
      }

      try {
        const result = await deps.channel.handleClientEvent(parsed);
        write(result.messages);

        // Dispatch AFTER acknowledging. The client's retry loop should never
        // wait on Tree-sitter or a gate decision, and the orchestrator reads
        // committed evidence either way.
        if (result.event) await deps.dispatch(result.event);
      } catch (err) {
        deps.log?.error({ sessionId, err }, "session channel failed");
        write([{ kind: "ERROR", code: "INTERNAL", message: "event could not be processed" }]);
      }
    })();
  });

  socket.on("close", () => {
    detach?.();
    // Clear the sequence watermark so a reconnecting client resuming from its
    // own last-acked seq is not mistaken for one with a gap.
    deps.channel.forget(sessionId);
  });

  socket.on("error", (err) => {
    deps.log?.warn({ sessionId, err: err.message }, "session socket error");
  });
}

/**
 * Route shape the websocket plugin adds to Fastify.
 *
 * A narrow local cast instead of relying on the plugin's module augmentation.
 * The augmentation is real, but depending on it here would make this file fail
 * to typecheck whenever the plugin is absent — and the plugin is optional at
 * boot on purpose (see below).
 */
type WebSocketRoutes = {
  get(
    path: string,
    opts: { websocket: true },
    handler: (socket: SocketLike, req: { params: { id: string } }) => void,
  ): void;
};

export async function registerEventsSocket(
  app: FastifyInstance,
  deps: EventsSocketDeps,
): Promise<void> {
  /**
   * Optional at boot.
   *
   * The API is useful without a socket — sessions, runs, reports and the whole
   * HTTP surface still work — so a missing plugin degrades to a warning rather
   * than refusing to start. Same reasoning as the judge being optional: a missing
   * dependency should cost a capability, not the service.
   */
  let plugin: { default: unknown } | null = null;
  try {
    plugin = (await import("@fastify/websocket")) as { default: unknown };
  } catch {
    app.log.warn("@fastify/websocket not installed; WS /interview-sessions/:id/events disabled");
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(plugin.default as any);

  const routes = app as unknown as WebSocketRoutes;
  routes.get("/interview-sessions/:id/events", { websocket: true }, (socket, req) => {
    handleConnection(socket, req.params.id, { ...deps, log: app.log });
  });
}
