import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CONTENT_ROOT } from "../../index.js";
import { parseScenario, scenarioRef } from "./loader.js";
import { FileQuestionBank, QuestionBankError, SupabaseQuestionBank, chooseQuestion, questionBankFromEnv, questionBankSource } from "./question-bank.js";

let raw: string;
beforeAll(async () => { raw = await readFile(join(CONTENT_ROOT, "conveyor-rescan/v1.yaml"), "utf8"); });

const secretKey = "sb_secret_unit_test_only";
const row = (overrides: Record<string, unknown> = {}) => {
  const question = parseScenario(raw, "fixture");
  return { version_id: question.version.id, public_ref: scenarioRef(question.version.id), status: "ACTIVE", content_yaml: raw, content_hash: question.contentHash, ...overrides };
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const make = (fetcher: typeof fetch) => new SupabaseQuestionBank({ url: "https://project.supabase.co", secretKey, fetch: fetcher });

describe("private Supabase question bank", () => {
  it("uses the secret apikey header and refuses redirects without forwarding it as a bearer JWT", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json([row()]));
    const question = await make(fetcher).get(scenarioRef("conveyor-rescan@1"));
    expect(question?.version.id).toBe("conveyor-rescan@1");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).not.toContain(secretKey);
    expect(new Headers(init?.headers).get("apikey")).toBe(secretKey);
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeDefined();
  });

  it("supports a legacy service-role JWT but rejects anon and publishable keys", () => {
    const jwt = (role: string) => `header.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`;
    expect(() => new SupabaseQuestionBank({ url: "https://project.supabase.co", secretKey: jwt("service_role") })).not.toThrow();
    for (const key of [jwt("anon"), "sb_publishable_example", ""]) {
      expect(() => new SupabaseQuestionBank({ url: "https://project.supabase.co", secretKey: key })).toThrow(QuestionBankError);
    }
  });

  it("never transmits secrets to insecure remote URLs or URLs with embedded credentials", () => {
    for (const url of ["http://project.supabase.co", "https://user:pass@project.supabase.co", "https://project.supabase.co/?key=foo", "https://project.supabase.co/other", "not-a-url"]) {
      expect(() => new SupabaseQuestionBank({ url, secretKey })).toThrow(QuestionBankError);
    }
    expect(() => new SupabaseQuestionBank({ url: "http://127.0.0.1:54321", secretKey })).not.toThrow();
  });

  it("paginates until empty even if the database row cap returns a short page", async () => {
    const first = row();
    const secondRaw = raw.replaceAll("conveyor-rescan", "other-question");
    const second = row({ version_id: "other-question@1", public_ref: scenarioRef("other-question@1"), content_yaml: secondRaw, content_hash: parseScenario(secondRaw, "fixture").contentHash });
    const rows = [first, second].sort((a, b) => a.public_ref.localeCompare(b.public_ref));
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json([rows[0]])).mockResolvedValueOnce(json([rows[1]])).mockResolvedValueOnce(json([]));
    expect(await make(fetcher).listActive()).toHaveLength(2);
    const secondUrl = new URL(String(fetcher.mock.calls[1]![0]));
    expect(secondUrl.searchParams.get("public_ref")).toBe(`gt.${rows[0]!.public_ref}`);
    expect(secondUrl.searchParams.get("status")).toBe("eq.ACTIVE");
  });

  it("rejects repeated pages instead of looping or returning duplicate questions", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json([row()]));
    await expect(make(fetcher).listActive()).rejects.toMatchObject({ code: "INVALID_CONTENT" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("verifies both source hash and identity before returning content", async () => {
    for (const overrides of [{ content_hash: `sha256:${"0".repeat(64)}` }, { version_id: "another@1" }, { public_ref: "scn_0000000000000000" }, { content_yaml: "bad: yaml" }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json([row(overrides)]));
      await expect(make(fetcher).get("conveyor-rescan@1")).rejects.toMatchObject({ code: "INVALID_CONTENT" });
    }
  });

  it("rejects a valid but different question returned for a specific ref", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json([row()]));
    await expect(make(fetcher).get("wrong-question@1")).rejects.toMatchObject({ code: "INVALID_CONTENT" });
  });

  it("returns retired versions by ID for existing pins but will not list them as active", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json([row({ status: "RETIRED" })]));
    expect((await make(fetcher).get("conveyor-rescan@1"))?.version.status).toBe("RETIRED");
    await expect(make(fetcher).listActive()).rejects.toMatchObject({ code: "INVALID_CONTENT" });
  });

  it("sanitizes provider and transport errors without leaking keys or private content", async () => {
    for (const fetcher of [
      vi.fn<typeof fetch>().mockResolvedValue(json({ message: `failure ${secretKey} ${raw}` }, 500)),
      vi.fn<typeof fetch>().mockRejectedValue(new Error(`URL included ${secretKey}`)),
    ]) {
      await expect(make(fetcher).get("conveyor-rescan@1")).rejects.toThrow("Question bank unavailable");
    }
  });

  it("rejects malformed responses and handles absent questions", async () => {
    await expect(make(vi.fn<typeof fetch>().mockResolvedValue(json({ data: [] }))).get("conveyor-rescan@1")).rejects.toMatchObject({ code: "INVALID_CONTENT" });
    expect(await make(vi.fn<typeof fetch>().mockResolvedValue(json([]))).get("conveyor-rescan@1")).toBeNull();
    const fetcher = vi.fn<typeof fetch>();
    expect(await make(fetcher).get("x,or(status.eq.ACTIVE)")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("imports new versions and does not overwrite or reactivate existing versions", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json([])).mockResolvedValueOnce(json([row()]));
    expect(await make(fetcher).importSource(raw)).toBe("inserted");
    expect(fetcher.mock.calls[1]![1]?.method).toBe("POST");
    const existing = vi.fn<typeof fetch>().mockResolvedValue(json([row({ status: "RETIRED" })]));
    expect(await make(existing).importSource(raw)).toBe("existing");
    expect(existing).toHaveBeenCalledTimes(1);
  });

  it("refuses different source bytes for an existing version", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json([row()]));
    await expect(make(fetcher).importSource(`${raw}\n# changed bytes\n`)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("verifies the winner after a concurrent import conflict", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json([])).mockResolvedValueOnce(json([])).mockResolvedValueOnce(json([row()]));
    expect(await make(fetcher).importSource(raw)).toBe("existing");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("requires a license reference for licensed questions", async () => {
    const licensed = raw.replace(/type: ORIGINAL/, "type: LICENSED");
    expect(licensed).not.toBe(raw);
    const fetcher = vi.fn<typeof fetch>();
    await expect(make(fetcher).importSource(licensed)).rejects.toMatchObject({ code: "INVALID_CONTENT" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("question source configuration", () => {
  it("allows offline file fixtures, but deployment requires Supabase", () => {
    expect(questionBankSource({})).toBe("files");
    expect(questionBankSource({ NODE_ENV: "production" })).toBe("supabase");
    expect(() => questionBankSource({ NODE_ENV: "production", QUESTION_BANK_SOURCE: "files" })).toThrow(QuestionBankError);
    expect(() => questionBankSource({ QUESTION_BANK_SOURCE: "typo" })).toThrow(QuestionBankError);
    expect(() => questionBankFromEnv({ QUESTION_BANK_SOURCE: "supabase" }, new Map())).toThrow(QuestionBankError);
  });

  it("selects only active questions and handles an empty bank", async () => {
    const active = parseScenario(raw, "fixture");
    const retired = { ...active, version: { ...active.version, id: "retired@1", status: "RETIRED" as const } };
    const library = new Map([[active.version.id, active], [retired.version.id, retired]]);
    expect(await new FileQuestionBank(library).listActive()).toEqual([active]);
    expect(chooseQuestion([retired, active])).toEqual(active);
    expect(chooseQuestion([retired])).toBeNull();
  });
});
