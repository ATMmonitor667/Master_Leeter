import { randomInt } from "node:crypto";
import { ScenarioStatusSchema } from "@master-leeter/contracts";
import { z } from "zod";
import { type LoadedScenario, parseScenario, resolveScenario, scenarioRef, selectableScenarios } from "./loader.js";

/** Private content source. Only the catalogue projection may reach the browser. */
export interface QuestionBank {
  readonly kind: "files" | "supabase";
  listActive(): Promise<LoadedScenario[]>;
  get(refOrId: string): Promise<LoadedScenario | null>;
}

export class QuestionBankError extends Error {
  constructor(readonly code: "UNAVAILABLE" | "INVALID_CONTENT" | "VERSION_CONFLICT" | "CONFIGURATION") {
    // Provider bodies, request URLs and credentials must never be error messages.
    super(`Question bank ${code.toLowerCase().replaceAll("_", " ")}`);
    this.name = "QuestionBankError";
  }
}

export class FileQuestionBank implements QuestionBank {
  readonly kind = "files";
  constructor(private readonly library: Map<string, LoadedScenario>) {}
  async listActive(): Promise<LoadedScenario[]> { return selectableScenarios(this.library); }
  async get(refOrId: string): Promise<LoadedScenario | null> { return resolveScenario(this.library, refOrId); }
}

export function chooseQuestion(questions: LoadedScenario[]): LoadedScenario | null {
  const active = questions.filter((question) => question.version.status === "ACTIVE");
  return active.length ? active[randomInt(active.length)]! : null;
}

const RowSchema = z.object({
  version_id: z.string().regex(/^[a-z0-9-]+@[1-9][0-9]*$/),
  public_ref: z.string().regex(/^scn_[a-f0-9]{16}$/),
  status: ScenarioStatusSchema,
  content_yaml: z.string().min(1).max(250_000),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
type QuestionRow = z.infer<typeof RowSchema>;

function decodeRow(value: unknown): LoadedScenario {
  const parsed = RowSchema.safeParse(value);
  if (!parsed.success) throw new QuestionBankError("INVALID_CONTENT");
  const row = parsed.data;
  let loaded: LoadedScenario;
  try { loaded = parseScenario(row.content_yaml, `supabase:${row.public_ref}`); }
  catch { throw new QuestionBankError("INVALID_CONTENT"); }
  if (loaded.version.id !== row.version_id || loaded.contentHash !== row.content_hash ||
      scenarioRef(loaded.version.id) !== row.public_ref ||
      (loaded.version.provenance.type === "LICENSED" && !loaded.version.provenance.licenseRef?.trim()) ||
      (row.status === "ACTIVE" && !loaded.version.provenance.reviewNotes.trim())) {
    throw new QuestionBankError("INVALID_CONTENT");
  }
  // Publication status is mutable metadata; the source bytes and version are not.
  return { ...loaded, version: { ...loaded.version, status: row.status } };
}

export interface SupabaseQuestionBankOptions {
  url: string;
  secretKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Shared validation for dry runs and writes, before contacting the database. */
export function questionRowFromSource(raw: string): QuestionRow {
  let loaded: LoadedScenario;
  try { loaded = parseScenario(raw, "question-bank-import"); }
  catch { throw new QuestionBankError("INVALID_CONTENT"); }
  const row: QuestionRow = {
    version_id: loaded.version.id, public_ref: scenarioRef(loaded.version.id),
    status: loaded.version.status, content_yaml: raw, content_hash: loaded.contentHash,
  };
  decodeRow(row);
  return row;
}

export class SupabaseQuestionBank implements QuestionBank {
  readonly kind = "supabase";
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: SupabaseQuestionBankOptions) {
    let url: URL;
    try { url = new URL(opts.url); } catch { throw new QuestionBankError("CONFIGURATION"); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
        url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      throw new QuestionBankError("CONFIGURATION");
    }
    const key = opts.secretKey.trim();
    // New Supabase secret keys go in apikey, not Authorization: Bearer.
    // Legacy service-role JWTs need both. Reject anon/publishable keys early.
    if (!key.startsWith("sb_secret_")) {
      try {
        const payload = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
        if (payload["role"] !== "service_role" || key.split(".").length !== 3) throw new Error();
      } catch { throw new QuestionBankError("CONFIGURATION"); }
    }
    this.endpoint = `${url.origin}/rest/v1/interview_questions`;
    this.headers = { apikey: key, "content-type": "application/json", ...(key.startsWith("sb_secret_") ? {} : { authorization: `Bearer ${key}` }) };
    this.fetcher = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
  }

  private async request(query: URLSearchParams, init: RequestInit = {}, signal = AbortSignal.timeout(this.timeoutMs)): Promise<unknown[]> {
    try {
      const response = await this.fetcher(`${this.endpoint}?${query}`, {
        ...init, headers: { ...this.headers, ...init.headers }, signal,
        // Never follow a redirect carrying the service key to another host.
        redirect: "error",
      });
      if (!response.ok) throw new QuestionBankError("UNAVAILABLE");
      const rows: unknown = await response.json();
      if (!Array.isArray(rows)) throw new QuestionBankError("INVALID_CONTENT");
      return rows;
    } catch (error) {
      if (error instanceof QuestionBankError) throw error;
      throw new QuestionBankError("UNAVAILABLE");
    }
  }

  async listActive(): Promise<LoadedScenario[]> {
    const questions: LoadedScenario[] = [];
    const seen = new Set<string>();
    const signal = AbortSignal.timeout(this.timeoutMs);
    let cursor: string | undefined;
    // Keyset pagination handles project-level row caps below our requested page size.
    // One timeout covers the whole catalogue, and an upper bound prevents runaway reads.
    for (let page = 0; page < 200; page++) {
      const query = new URLSearchParams({ select: "version_id,public_ref,status,content_yaml,content_hash", status: "eq.ACTIVE", order: "public_ref.asc", limit: "50" });
      if (cursor) query.set("public_ref", `gt.${cursor}`);
      const rows = await this.request(query, {}, signal);
      if (rows.length === 0) return questions;
      for (const row of rows) {
        const question = decodeRow(row);
        const ref = scenarioRef(question.version.id);
        if (question.version.status !== "ACTIVE" || seen.has(ref) || (cursor && ref <= cursor)) {
          throw new QuestionBankError("INVALID_CONTENT");
        }
        seen.add(ref);
        questions.push(question);
        cursor = ref;
      }
    }
    throw new QuestionBankError("UNAVAILABLE");
  }

  async get(refOrId: string): Promise<LoadedScenario | null> {
    const isRef = /^scn_[a-f0-9]{16}$/.test(refOrId);
    if (!isRef && !/^[a-z0-9-]+@[1-9][0-9]*$/.test(refOrId)) return null;
    const query = new URLSearchParams({ select: "version_id,public_ref,status,content_yaml,content_hash", limit: "1" });
    query.set(isRef ? "public_ref" : "version_id", `eq.${refOrId}`);
    const rows = await this.request(query);
    if (!rows.length) return null;
    const loaded = decodeRow(rows[0]);
    if ((isRef ? scenarioRef(loaded.version.id) : loaded.version.id) !== refOrId) throw new QuestionBankError("INVALID_CONTENT");
    return loaded;
  }

  /** Operator-only importer. No HTTP route exposes bank mutation to candidates. */
  async importSource(raw: string): Promise<"inserted" | "existing"> {
    const row = questionRowFromSource(raw);
    const prior = await this.get(row.version_id);
    if (prior) {
      if (prior.contentHash !== row.content_hash) throw new QuestionBankError("VERSION_CONFLICT");
      return "existing"; // Never reactivate retired content during a re-import.
    }
    const inserted = await this.request(new URLSearchParams({ on_conflict: "version_id" }), {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(row),
    });
    // A concurrent importer may have won the insert; verify rather than overwrite.
    const stored = inserted.length ? decodeRow(inserted[0]) : await this.get(row.version_id);
    if (!stored || stored.version.id !== row.version_id || stored.contentHash !== row.content_hash) {
      throw new QuestionBankError("VERSION_CONFLICT");
    }
    return inserted.length ? "inserted" : "existing";
  }
}

export function questionBankSource(env: NodeJS.ProcessEnv): "files" | "supabase" {
  const source = env["QUESTION_BANK_SOURCE"] ?? (env["NODE_ENV"] === "production" ? "supabase" : "files");
  if (source !== "files" && source !== "supabase") throw new QuestionBankError("CONFIGURATION");
  if (env["NODE_ENV"] === "production" && source !== "supabase") throw new QuestionBankError("CONFIGURATION");
  return source;
}

export function questionBankFromEnv(env: NodeJS.ProcessEnv, library: Map<string, LoadedScenario>): QuestionBank {
  if (questionBankSource(env) === "files") return new FileQuestionBank(library);
  const url = env["SUPABASE_URL"];
  const secretKey = env["SUPABASE_SECRET_KEY"] || env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !secretKey) throw new QuestionBankError("CONFIGURATION");
  return new SupabaseQuestionBank({ url, secretKey });
}
