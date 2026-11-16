/**
 * Live voice check (rebuild plan, step 1, kept as a repeatable script).
 *
 *   pnpm live:check            (API must be running on :4000)
 *
 * Creates a voice session, mints a credential through the API, connects with
 * the same GeminiLive adapter the browser uses, and reports: time to first
 * audio for the opening, whether a silent [CODE] injection stays silent, and
 * whether a question about that code is answered. No microphone needed.
 */
import type { LiveCredential } from "@master-leeter/contracts";
import { codeContext, cueText } from "@master-leeter/contracts";
import { GeminiLive } from "./gemini-live";

const API = process.env["API_URL"] ?? "http://localhost:4000";
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${API}/v1${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
};

const created = await post("/interview-sessions", { format: "VOICE", style: "NEUTRAL", minutes: 30 }, { "idempotency-key": crypto.randomUUID() });
const id = String(created["sessionId"]);
const credential = (await post(`/interview-sessions/${id}/live`, {})) as unknown as LiveCredential;
if (JSON.stringify(credential).includes("PRIVATE NOTES")) throw new Error("the prompt leaked into the credential response");

let audioMs = 0;
let firstAudioAt: number | null = null;
let said = "";
let turnDone: (() => void) | null = null;
const live = new GeminiLive({
  audio: (pcm) => { firstAudioAt ??= performance.now(); audioMs += (pcm.length / 24_000) * 1000; },
  interrupted: () => {}, userText: () => {}, speech: () => {}, goAway: () => {}, resumption: () => {},
  modelText: (fragment) => { said += fragment; },
  turnEnd: () => turnDone?.(),
  closed: (info) => { if (!info.expected) console.log("closed:", info.code, info.reason); },
});

async function turn(label: string, send: () => void, waitMs: number) {
  audioMs = 0; firstAudioAt = null; said = "";
  const start = performance.now();
  send();
  await new Promise<void>((resolve) => { const timer = setTimeout(resolve, waitMs); turnDone = () => { clearTimeout(timer); resolve(); }; });
  turnDone = null;
  console.log(`${label}\n  first audio: ${firstAudioAt === null ? "none" : `${Math.round(firstAudioAt - start)} ms`} · ${(audioMs / 1000).toFixed(1)} s of audio\n  said: ${said.trim() || "(nothing)"}`);
  return { spoke: firstAudioAt !== null, said };
}

await live.connect(credential);
console.log("connected with a server-pinned prompt");
const opening = await turn("[START]", () => live.sendText(cueText("START"), { respond: true }), 40_000);
const silent = await turn("[CODE] injected with respond:false (expect silence)",
  () => live.sendText(codeContext(1, "def solve(items):\n    seen = set()\n    return len(seen)\n"), { respond: false }), 5_000);
const aware = await turn("typed question about the code",
  () => live.sendText("What is the name of the variable I create on the first line of my function?", { respond: true }), 25_000);
live.close();
await post(`/interview-sessions/${id}/end`, {});

const ok = opening.spoke && !silent.spoke && /seen/i.test(aware.said);
console.log(ok ? "\nPASS" : "\nFAIL");
process.exit(ok ? 0 : 1);
