import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SessionStore } from "../session/session-store.js";

export interface Principal { userId: string; expiresAt: number }
export interface Authenticator { verify(token: string): Promise<Principal> }
export class AuthError extends Error {
  constructor(readonly code: "UNAUTHORIZED" | "AUTH_UNAVAILABLE" | "AUTH_CONFIGURATION") {
    super(code);
  }
}

/** Validates with Supabase Auth on every request, including user revocation. */
export class SupabaseAuthenticator implements Authenticator {
  private readonly endpoint: string;
  constructor(private readonly opts: { url: string; publicKey: string; fetch?: typeof fetch }) {
    let url: URL;
    try { url = new URL(opts.url); } catch { throw new AuthError("AUTH_CONFIGURATION"); }
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/" || !opts.publicKey.trim() || opts.publicKey.startsWith("sb_secret_")) {
      throw new AuthError("AUTH_CONFIGURATION");
    }
    this.endpoint = `${url.origin}/auth/v1/user`;
  }

  async verify(token: string): Promise<Principal> {
    if (!token || token.length > 8192 || token.split(".").length !== 3) throw new AuthError("UNAUTHORIZED");
    try {
      const response = await (this.opts.fetch ?? fetch)(this.endpoint, {
        headers: { apikey: this.opts.publicKey, authorization: `Bearer ${token}` },
        redirect: "error", signal: AbortSignal.timeout(8_000),
      });
      if (response.status === 401 || response.status === 403) throw new AuthError("UNAUTHORIZED");
      if (!response.ok) throw new AuthError("AUTH_UNAVAILABLE");
      const user = z.object({ id: z.string().uuid(), is_anonymous: z.boolean().optional() }).safeParse(await response.json());
      if (!user.success || user.data.is_anonymous) throw new AuthError("UNAUTHORIZED");
      // The provider validated the JWT above. Only now use its expiry to bound
      // socket lifetime; matching subject prevents an inconsistent provider reply.
      const claims = z.object({ sub: z.string().uuid(), exp: z.number().int().positive() }).safeParse(
        JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")),
      );
      if (!claims.success || claims.data.sub !== user.data.id || claims.data.exp * 1000 <= Date.now()) throw new AuthError("UNAUTHORIZED");
      return { userId: user.data.id, expiresAt: claims.data.exp * 1000 };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      // Never leak tokens, URLs, provider response bodies or user data.
      throw new AuthError("AUTH_UNAVAILABLE");
    }
  }
}

export function authenticatorFromEnv(env: NodeJS.ProcessEnv): Authenticator | undefined {
  const mode = env["AUTH_MODE"] ?? "supabase";
  if (mode === "development" && env["ALLOW_INSECURE_DEV"] === "1" &&
      ["development", "test"].includes(env["NODE_ENV"] ?? "")) return undefined;
  if (mode !== "supabase" || !env["SUPABASE_URL"] || !env["SUPABASE_PUBLISHABLE_KEY"]) throw new AuthError("AUTH_CONFIGURATION");
  return new SupabaseAuthenticator({ url: env["SUPABASE_URL"], publicKey: env["SUPABASE_PUBLISHABLE_KEY"] });
}

interface Ticket { sessionId: string; principal: Principal; expiresAt: number }
/** One pending ticket per user/session. Process-local until distributed storage. */
export class SocketTickets {
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly now = Date.now) {}
  issue(sessionId: string, principal: Principal): string {
    for (const [key, value] of this.tickets) {
      if (value.expiresAt <= this.now() || (value.sessionId === sessionId && value.principal.userId === principal.userId)) this.tickets.delete(key);
    }
    if (principal.expiresAt <= this.now()) throw new AuthError("UNAUTHORIZED");
    if (this.tickets.size >= 10_000) throw new AuthError("AUTH_UNAVAILABLE");
    const token = randomBytes(32).toString("base64url");
    this.tickets.set(this.hash(token), { sessionId, principal, expiresAt: Math.min(this.now() + 30_000, principal.expiresAt) });
    return token;
  }
  take(token: string, sessionId: string): Principal | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const key = this.hash(token);
    const entry = this.tickets.get(key);
    // Wrong-session redemption never authenticates. Correct redemption consumes
    // before any await, making reuse impossible on this process.
    if (!entry || entry.sessionId !== sessionId) return null;
    this.tickets.delete(key);
    return entry.expiresAt > this.now() ? entry.principal : null;
  }
  private hash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
}

declare module "fastify" { interface FastifyRequest { principal: Principal | null } }

export function userIdFor(request: FastifyRequest): string {
  // The header fallback exists only in explicit local development/test mode:
  // secure requests cannot reach a handler without a verified principal.
  return request.principal?.userId ?? (typeof request.headers["x-user-id"] === "string" ? request.headers["x-user-id"] : "anonymous");
}

export function registerAccessControl(app: FastifyInstance, opts: {
  authenticator?: Authenticator; sessions: SessionStore; webOrigin: string; tickets: SocketTickets;
}): void {
  app.decorateRequest("principal", null);
  app.addHook("preHandler", async (req, reply) => {
    const route = req.routeOptions.url ?? "";
    if (!route.startsWith("/v1/") || req.method === "OPTIONS") return;
    const origin = req.headers.origin;
    if (opts.authenticator && origin && origin !== opts.webOrigin) return reply.code(403).send({ error: "ORIGIN_NOT_ALLOWED" });
    if (route === "/v1/scenarios" && req.method === "GET") return;
    if (!opts.authenticator) return;
    reply.header("Cache-Control", "no-store");
    try {
      const id = (req.params as { id?: string }).id;
      if (route === "/v1/interview-sessions/:id/events") {
        // Browser WebSocket APIs cannot attach an Authorization header. Only a
        // fresh ticket obtained through authenticated HTTP may open this route.
        if (origin !== opts.webOrigin || !id) return reply.code(403).send({ error: "ORIGIN_NOT_ALLOWED" });
        const query = z.object({ ticket: z.string().max(100) }).strict().safeParse(req.query);
        req.principal = query.success ? opts.tickets.take(query.data.ticket, id) : null;
        if (!req.principal) throw new AuthError("UNAUTHORIZED");
      } else {
        const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "");
        if (!match) throw new AuthError("UNAUTHORIZED");
        req.principal = await opts.authenticator.verify(match[1]!);
      }
      if (id && (route.startsWith("/v1/interview-sessions/:id") || route.startsWith("/v1/privacy/sessions/:id"))) {
        if (!z.string().uuid().safeParse(id).success) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
        const session = await opts.sessions.get(id);
        if (!session || session.userId !== req.principal.userId) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
        if (route.endsWith("/events") && session.endedAt) return reply.code(409).send({ error: "SESSION_ENDED" });
      }
      // Regeneration is an operator function until a verified admin role exists.
      if (route.endsWith("/report/regenerate")) return reply.code(403).send({ error: "OPERATOR_ONLY" });
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      return reply.code(error.code === "UNAUTHORIZED" ? 401 : 503).send({ error: error.code });
    }
  });
  app.get("/v1/me", async (req) => ({ userId: userIdFor(req), authentication: opts.authenticator ? "supabase" : "development" }));
  app.post("/v1/interview-sessions/:id/socket-ticket", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await opts.sessions.get(id);
    if (!session) return reply.code(404).send({ error: "UNKNOWN_SESSION" });
    if (session.endedAt) return reply.code(409).send({ error: "SESSION_ENDED" });
    const principal = req.principal ?? { userId: userIdFor(req), expiresAt: Date.now() + 55 * 60_000 };
    return reply.header("Cache-Control", "no-store").send({ ticket: opts.tickets.issue(id, principal) });
  });
}
