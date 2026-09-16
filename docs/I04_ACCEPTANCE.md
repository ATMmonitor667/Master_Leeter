# I04 acceptance — voice lifetime and completion races

Item 5 of I04 is verification, not implementation. The code paths exist; what is
missing is evidence that they behave against a real database and a real round.
This is that procedure. It requires a development Supabase project and a person
at a microphone, and it cannot be closed by source inspection.

Close a check only by recording the observed evidence next to it. A check that
"looks right in the code" is not closed.

## Preconditions

- Migrations applied through the highest numbered file in `apps/api/migrations`
  against the **development** project, never production.
- API running with durable mode enabled and no memory fallback. Confirm the boot
  log names the PostgreSQL stores; a silent in-memory start invalidates every
  check below, because none of these races exist in a single-process map.
- `REALTIME_MODEL` / `REALTIME_API_KEY` configured with quota for ~50 minutes of
  audio, since two of the checks need a genuine 45-minute session.
- A second browser profile signed in as a **different** account, for check 6.

## 1. Server-owned deadline

1. Start a session, note `expectedSeconds` in `SESSION_STARTED` (must be 2700).
2. In the database, move `started_at` back so under a minute remains.
3. Leave the tab open and idle.

Expected: within one sweep interval (5s) the session ends on its own. The client
receives an `ERROR` frame with code `SESSION_ENDED`. `SESSION_ENDED` is appended
exactly once and carries `sealedClientSeq`. A report job is enqueued once.

Then repeat with the **tab closed** before the deadline. The interview must still
complete — the sweep is server-side and does not need a live client. This is the
check that distinguishes a real deadline from a browser timer.

## 2. Reconnect without losing the clock

1. Mid-interview, kill the network for ~30 seconds, then restore it.
2. Refresh the page entirely.

Expected: code, notes, stage and remaining time are restored from the pinned
question and checkpoints — not from browser state. `pausedSeconds` increases by
roughly the outage, so the outage is not billed to the candidate. The stage after
reconnect is the server's, not `ORAL_PROBLEM_DELIVERY`. Voice resumes without
replaying the opening brief.

Record the remaining time before and after. A clock that jumps forward by the
outage is a failure even though nothing errored.

## 3. Final keystroke

1. Type into the editor and, within the debounce window, click Complete Interview.

Expected: the end request carries `finalClientSeq`. If the last edit is not yet
durable the API returns **409 `FINAL_INPUTS_PENDING`** with `expectedClientSeq`
and `durableClientSeq`, the client retries, and the eventual `SESSION_ENDED`
records a `sealedClientSeq` at least as high as the last acknowledged edit.

Then confirm the final code in the report matches the editor's last content
character for character. The 409 path is the point of this check — if you never
observe one, force it by adding latency to the event append and retrying.

## 4. Final spoken answer

1. Answer a question aloud and click Complete Interview while still speaking.

Expected: the finalized transcript segment for that utterance is present in the
sealed evidence. Transcription is captured from the live audio path and does not
depend on captions being visible — run this check once with captions off.

## 5. Late writes after sealing

1. After completion, replay an editor write and a voice-tool call from the
   browser devtools against the ended session.

Expected: every mutating route returns **409 `SESSION_ENDED`**. No new event is
appended. `POST /voice-resumption` also returns 409 and clears any stored handle,
so an ended interview cannot be resumed into.

Confirm in the database that the event count is unchanged after these attempts.

## 6. Cross-account isolation

From the second account, attempt: `GET` the session, `POST` an edit, mint a
realtime token, `POST /voice-resumption`, and fetch the report.

Expected: all refused by ownership. In particular a handle reported by account B
must never influence a credential minted for account A's session — the mint route
reads only the handle stored against the session being minted for, so verify the
`resumed` field in the mint log reflects account A's own handle.

## 7. Device loss during a live round

1. Mid-interview, unplug the active microphone.
2. Reconnect it.
3. Separately, unplug the active speaker.

Expected: microphone loss recovers automatically onto the same device or the
system default without ending the round, and interview time keeps running because
the deadline is server-owned. Speaker loss falls back to the default output and
the interviewer stays audible — silence here is the failure mode, so confirm by
ear, not by the absence of an error.

If recovery fails, the session must stay recoverable: the picker offers a device
and choosing one returns status to listening without restarting the interview.

## 8. Restart mid-interview

Restart the API process while a session is live.

Expected: the interview survives. Runtime rehydrates from the pinned question and
checkpoints with hints, probes, disclosed facts and client sequence intact. Voice
reconnects with a fresh provider session. The resumption handle is deliberately
lost here — it is in-process transport state — so the only acceptable symptom is
the provider losing carried audio context, never the interview losing state.

## What this procedure does not cover

Grading (I05), cost and quota enforcement (I06), and load behaviour. Passing every
check above closes I04's exit condition only.
