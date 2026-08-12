/**
 * M3-1 — ephemeral credential verification
 *
 * Usage (from repo root):
 *   pnpm --filter @master-leeter/api verify:token
 *
 * Requires in apps/api/.env.local:
 *   REALTIME_API_KEY, REALTIME_MODEL
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `token.test.ts` proves the minter builds the right request and that the route
 * never leaks the key. Neither of those requires the provider to exist, so both
 * would stay green against an endpoint that had been renamed, a constraint field
 * the API rejects, or a token that mints fine and then cannot open a socket.
 *
 * This closes that gap without a microphone. It mints a real credential, opens
 * a real constrained session with it, and checks the three properties the issue
 * actually claims:
 *
 *   1. The credential opens a Live session — the endpoint and constraint shape
 *      are right, not merely plausible.
 *   2. It is single-use — a second connection with the same token is refused.
 *   3. The session it opens does not speak on its own — ADR-001, now enforced by
 *      the credential rather than by client setup code.
 *
 * (3) is the one worth the network round trip. Every other check here could be
 * wrong and the product would still work; if (3) fails, the invariant this whole
 * product is built on is not actually being enforced where we think it is.
 *
 * What this does NOT verify: audio in, audio out, turn boundaries, latency.
 * Those need M3-2 and a real microphone. This is the last thing that can be
 * measured before that, and it should be run once before M3-2 starts so that a
 * failure there is known to be M3-2's.
 */

import { loadEnv } from "../src/env.js";
import { GeminiTokenMinter, toModelResource } from "../src/modules/realtime/token.js";

loadEnv();

const API_KEY = process.env["REALTIME_API_KEY"];
const MODEL = process.env["REALTIME_MODEL"] ?? "gemini-2.5-flash-native-audio-latest";
const VOICE = process.env["REALTIME_VOICE"] ?? "Puck";

/** Seconds to sit on an open socket listening for audio nobody asked for. */
const LISTEN_MS = 4_000;

if (!API_KEY) {
  console.error("REALTIME_API_KEY is missing. Set it in apps/api/.env.local.");
  process.exit(1);
}

type Json = Record<string, unknown>;

interface CheckResult {
  minted: boolean;
  keyAbsentFromCredential: boolean;
  sessionOpened: boolean;
  singleUse: boolean;
  unpromptedAudioEvents: number;
  mintMs: number;
  openMs: number;
  notes: string[];
}

async function readWsData(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

async function parseWsMessage(data: unknown): Promise<Json | null> {
  try {
    return JSON.parse(await readWsData(data)) as Json;
  } catch {
    return null;
  }
}

function serverContent(msg: Json): Json | undefined {
  return (msg["serverContent"] ?? msg["server_content"]) as Json | undefined;
}

function hasModelAudio(msg: Json): boolean {
  const sc = serverContent(msg);
  const turn = (sc?.["modelTurn"] ?? sc?.["model_turn"]) as Json | undefined;
  const parts = turn?.["parts"] as Json[] | undefined;
  if (!parts) return false;
  return parts.some((p) => {
    const inline = (p["inlineData"] ?? p["inline_data"]) as Json | undefined;
    return String(inline?.["mimeType"] ?? inline?.["mime_type"] ?? "").includes("audio");
  });
}

function setupComplete(msg: Json): boolean {
  return msg["setupComplete"] !== undefined || msg["setup_complete"] !== undefined;
}

function errorOf(msg: Json): Json | undefined {
  return (msg["error"] ?? msg["errorMessage"] ?? msg["error_message"]) as Json | undefined;
}

/**
 * Open a constrained session and report what happened.
 *
 * Resolves rather than throws on refusal: a refused second connection is the
 * expected outcome of the single-use check, not an error.
 */
async function openSession(
  wsUrl: string,
  listenMs: number,
): Promise<{ opened: boolean; unpromptedAudio: number; detail: string; readyMs: number }> {
  const started = Date.now();
  /**
   * Time to `setupComplete`, NOT to the end of this function.
   *
   * The first version reported elapsed-on-return, which silently included the
   * listening window — so a 229ms connect was recorded as 4229ms. A latency
   * number nobody can interpret is worse than none, because it gets quoted.
   */
  let readyMs = 0;
  const ws = new WebSocket(wsUrl);
  let unpromptedAudio = 0;
  let detail = "";

  const audioWatch = (ev: MessageEvent) => {
    void parseWsMessage(ev.data).then((msg) => {
      if (msg && hasModelAudio(msg)) unpromptedAudio += 1;
    });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout opening socket")), 15_000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("socket refused"));
      }, { once: true });
      ws.addEventListener("close", (ev) => {
        clearTimeout(timer);
        reject(new Error(`socket closed before open (code ${ev.code})`));
      }, { once: true });
    });

    ws.addEventListener("message", audioWatch);

    // The constraints already pin model and config. Sending setup anyway is what
    // a real client does, and it is the case worth testing: if a client's setup
    // could widen what the token permits, the enforcement claim is false.
    ws.send(JSON.stringify({ setup: { model: toModelResource(MODEL) } }));

    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 15_000);
      const onMessage = (ev: MessageEvent) => {
        void parseWsMessage(ev.data).then((msg) => {
          if (!msg) return;
          const err = errorOf(msg);
          if (err) {
            detail = JSON.stringify(err).slice(0, 300);
            clearTimeout(timer);
            ws.removeEventListener("message", onMessage);
            resolve(false);
          }
          if (setupComplete(msg)) {
            readyMs = Date.now() - started;
            clearTimeout(timer);
            ws.removeEventListener("message", onMessage);
            resolve(true);
          }
        });
      };
      ws.addEventListener("message", onMessage);
    });

    if (!ready) {
      return {
        opened: false,
        unpromptedAudio,
        detail: detail || "no setupComplete",
        readyMs: Date.now() - started,
      };
    }

    // Say nothing. Send nothing. A correctly constrained session stays silent
    // through this, because the gate is the only thing that may authorize speech.
    await new Promise((r) => setTimeout(r, listenMs));

    return { opened: true, unpromptedAudio, detail: "", readyMs };
  } catch (err) {
    return {
      opened: false,
      unpromptedAudio,
      detail: err instanceof Error ? err.message : String(err),
      readyMs: Date.now() - started,
    };
  } finally {
    ws.removeEventListener("message", audioWatch);
    try {
      ws.close();
    } catch {
      // Already closed.
    }
  }
}

async function run(): Promise<CheckResult> {
  const result: CheckResult = {
    minted: false,
    keyAbsentFromCredential: false,
    sessionOpened: false,
    singleUse: false,
    unpromptedAudioEvents: 0,
    mintMs: 0,
    openMs: 0,
    notes: [],
  };

  const minter = new GeminiTokenMinter({ apiKey: API_KEY, model: MODEL, voice: VOICE });

  console.log(`M3-1 credential check — model=${MODEL} voice=${VOICE}`);
  console.log(`minter: ${minter.id}\n`);

  console.log("1. Minting an ephemeral credential");
  const t0 = Date.now();
  let credential;
  try {
    credential = await minter.mint();
  } catch (err) {
    console.error(`   FAIL: ${err instanceof Error ? err.message : String(err)}`);
    result.notes.push("mint failed — the message above is the provider's own explanation");
    return result;
  }
  result.mintMs = Date.now() - t0;
  result.minted = true;
  console.log(`   PASS: minted in ${result.mintMs}ms, expires ${credential.expiresAt}`);

  // Trivially true by construction, checked anyway: this is the acceptance
  // criterion, and a criterion nobody asserts is a criterion nobody keeps.
  const serialized = JSON.stringify(credential);
  result.keyAbsentFromCredential = !serialized.includes(API_KEY!);
  console.log(
    result.keyAbsentFromCredential
      ? "   PASS: credential contains no provider key"
      : "   FAIL: THE PROVIDER KEY IS IN THE CREDENTIAL — do not ship this",
  );

  console.log(`\n2. Opening a constrained session (listening ${LISTEN_MS}ms for unprompted audio)`);
  const first = await openSession(credential.wsUrl, LISTEN_MS);
  result.sessionOpened = first.opened;
  result.unpromptedAudioEvents = first.unpromptedAudio;
  result.openMs = first.readyMs;

  if (!first.opened) {
    console.error(`   FAIL: ${first.detail}`);
    result.notes.push(
      "session did not open — check the constraint shape in constrainedSetup() first; " +
        "a rejected field is the likeliest cause and the detail above usually names it",
    );
  } else {
    console.log(`   PASS: session opened in ${first.readyMs}ms (to setupComplete)`);
    console.log(
      first.unpromptedAudio === 0
        ? "   PASS: no unprompted model audio — silence is enforced by the credential"
        : `   FAIL: ${first.unpromptedAudio} unprompted audio event(s) — ADR-001 IS NOT ENFORCED`,
    );
  }

  console.log("\n3. Reusing the same token (expect refusal — uses: 1)");
  const second = await openSession(credential.wsUrl, 0);
  result.singleUse = !second.opened;
  console.log(
    result.singleUse
      ? `   PASS: reuse refused (${second.detail})`
      : "   FAIL: the token opened a second session — it is not single-use",
  );

  return result;
}

const result = await run();

console.log("\n════════ M3-1 credential check ════════");
console.log(`minted:                  ${result.minted}`);
console.log(`key_absent:              ${result.keyAbsentFromCredential}`);
console.log(`session_opened:          ${result.sessionOpened}`);
console.log(`single_use:              ${result.singleUse}`);
console.log(`unprompted_audio:        ${result.unpromptedAudioEvents}`);
console.log(`mint_ms:                 ${result.mintMs}`);
console.log(`open_ms:                 ${result.openMs}   (mint -> setupComplete, excl. listen window)`);
console.log("═══════════════════════════════════════");

for (const note of result.notes) console.log(`note: ${note}`);

const pass =
  result.minted &&
  result.keyAbsentFromCredential &&
  result.sessionOpened &&
  result.singleUse &&
  result.unpromptedAudioEvents === 0;

if (!pass) {
  console.error("\nM3-1 CHECK FAILED. Paste this summary into the chat before starting M3-2.");
  process.exitCode = 1;
} else {
  console.log("\nM3-1 CHECK PASSED. Record the numbers in docs/ISSUES.md under M3-1.");
}
