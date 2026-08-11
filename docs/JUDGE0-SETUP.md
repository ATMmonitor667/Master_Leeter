# Judge0 Setup — M0-2

Standing Judge0 up is the easy half. The half that matters is §6: a sandbox nobody has
attacked is a sandbox whose behaviour is unknown, and candidate code is untrusted by
definition (`CLAUDE.md` invariant 6).

**Your setup:** repo on Windows at `Desktop\Master_Leeter`, Judge0 release zip already in
WSL2 at `~/judge0-v1.13.1`. Node runs on the Windows side; only Judge0 lives in WSL. WSL2
forwards its listening ports to Windows `localhost`, so the two halves talk over
`http://localhost:2358` with no extra configuration.

Budget 1–2 hours, most of it in §1 if the cgroup config fights you.

---

## 1. WSL kernel config — do this first

Judge0's `isolate` requires cgroup **v1**. WSL2 increasingly defaults toward v2, and recent
builds add a `/wsl-user` cgroup-v2 hierarchy that is explicitly incompatible with v1
workloads. Get this wrong and every submission fails with `status 13 (Internal Error)` or
`No such file or directory @ rb_sysopen` — which reads like a Judge0 bug and isn't.

Most Judge0 guides tell you to edit `GRUB_CMDLINE_LINUX`. **WSL has no GRUB.** Ignore them.

Create or edit `C:\Users\ATM Rahat Hossain\.wslconfig` (Windows side, Notepad is fine):

```ini
[wsl2]
kernelCommandLine = systemd.unified_cgroup_hierarchy=0
isolateDistroCgroup = false
```

Then from **PowerShell**:

```powershell
wsl --shutdown
```

Reopen your Ubuntu terminal and confirm v1 is mounted:

```bash
mount | grep cgroup | head -5
```

You want lines showing `cgroup ... type cgroup` with controllers like `memory`, `cpuacct`,
`pids`. If you only see `cgroup2 ... type cgroup2`, the config didn't take — check the
`.wslconfig` path and that you ran `wsl --shutdown` from PowerShell, not from inside WSL.

`isolateDistroCgroup` is only recognised on newer WSL builds; on older ones it's harmlessly
ignored.

---

## 2. systemd and Docker Engine

Docker Desktop works too, but native Docker Engine inside WSL is fewer moving parts.

`/etc/wsl.conf`:

```ini
[boot]
systemd=true
```

`wsl --shutdown` from PowerShell again, reopen, then install Docker Engine:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Close and reopen the terminal so the group membership applies, then verify:

```bash
docker run --rm hello-world
```

If that hangs or errors, stop here — nothing downstream will work.

---

## 3. Configure Judge0

```bash
cd ~/judge0-v1.13.1
```

Generate two passwords and set them in `judge0.conf`:

```bash
head -c 32 /dev/urandom | base64   # run twice
```

Edit `judge0.conf`:

```
REDIS_PASSWORD=<first value>
POSTGRES_PASSWORD=<second value>
```

While you're in the file, check three more keys. These are the ones that cause confusing
failures later:

| Key | Want | Why |
|---|---|---|
| `ENABLE_WAIT_RESULT` | `true` | `Judge0Runner` submits with `?wait=true`. If this is false, every run errors instead of returning a result. |
| `ALLOW_ENABLE_NETWORK` | `false` | Belt and braces. The adapter already sends `enable_network: false` per submission; this makes it impossible for *any* submission to turn networking on. Invariant 6. |
| `MAX_CPU_TIME_LIMIT` / `MAX_MEMORY_LIMIT` / `MAX_PROCESSES_AND_OR_THREADS` | ≥ 5 / ≥ 262144 / ≥ 32 | Instance-level ceilings. The adapter requests those values per submission; if the instance caps lower, submissions are **rejected**, not clamped. |

Those three numbers come from `.env.example` (`RUNNER_*`) and are the limits
`apps/api/src/modules/runner/judge0.ts` sends on every run.

---

## 4. Start it

The order and the sleep are not superstition. The workers race the database and come up
permanently broken if it isn't ready.

```bash
cd ~/judge0-v1.13.1
docker compose up -d db redis
sleep 10
docker compose up -d
sleep 5
```

Verify:

```bash
curl http://localhost:2358/about
```

You should get JSON with a version. If not:

```bash
docker compose logs --tail=50
```

---

## 5. Baseline submission

Prove the happy path before trying to break it.

```bash
curl -s -X POST 'http://localhost:2358/submissions?base64_encoded=false&wait=true' \
  -H 'content-type: application/json' \
  -d '{"language_id":71,"source_code":"print(2+2)","cpu_time_limit":5}'
```

Expect `"stdout": "4\n"` and `"status": {"id": 3, "description": "Accepted"}`.

Language 71 is Python 3 — the MVP ships one language, and `LANGUAGE_IDS` in `judge0.ts`
maps `python → 71`.

---

## 6. Attack it — this is the actual deliverable

`scripts/judge0-setup.sh` automates all of this and prints a pasteable summary. From WSL:

```bash
cd /mnt/c/Users/'ATM Rahat Hossain'/Desktop/Master_Leeter
JUDGE0_DIR=~/judge0-v1.13.1 bash scripts/judge0-setup.sh
```

It's idempotent — it adopts your existing folder and skips work already done. If you'd
rather run the cases by hand, each is a `POST /submissions` with the source below and
`cpu_time_limit: 5`, `wall_time_limit: 10`, `memory_limit: 262144`,
`max_processes_and_or_threads: 32`, `enable_network: false`.

| # | Attack | Source | Must produce |
|---|---|---|---|
| 1 | Infinite loop | `while True: pass` | `Time Limit Exceeded` (5). **Not** a hung HTTP request. |
| 2 | Memory bomb | `x = [0] * (10**9)` | Runtime error (7–12) or clean kill. Must not swap your host. |
| 3 | Fork bomb | `import os`<br>`while True: os.fork()` | Terminated by the PID limit. |
| 4 | **Network** | `import urllib.request`<br>`urllib.request.urlopen("http://example.com")` | **Must fail.** If it returns 200, stop and fix the config before writing another line of code. |
| 5 | Filesystem read | `open("/etc/passwd").read()` | Record what happens. Reading is less alarming than writing, but know which you have. |
| 6 | Filesystem write | `open("/tmp/x","w").write("x")` | Should be confined to the box and discarded. |

**Record the actual outcomes**, including the surprising ones. Paste them to me and I'll
write them into `docs/adr/ADR-002-sandbox-isolation.md` and fix any normalisation in
`judge0.ts` that maps a status wrongly — `STATUS_MAP` and the OOM detection in `normalize()`
are written against the documented API, not against observed behaviour, and #2 in particular
is the case most likely to be mapped wrong.

> #4 is the one that must not surprise you. Candidate code reaching the internet means a
> candidate can exfiltrate your scenario's hidden tests, or fetch a solution mid-interview.

---

## 7. Connect it to the app

On the **Windows** side, in `apps/api/.env.local`:

```
JUDGE0_URL=http://localhost:2358
```

(Leave `JUDGE0_AUTH_TOKEN` unset unless you enabled auth in `judge0.conf`.)

`apps/api/src/env.ts` loads that file at boot. Restart the API and check:

```bash
pnpm dev:api
```

The boot log must contain `runner: "judge0"`. If it says `runner: "none"`, the variable never
reached the process — the API deliberately still starts, because an interview without
execution beats no interview at all, but every run will 503.

---

## 8. End-to-end verification

Judge0 answering `curl` is not the same as the product working. The path that matters is
client → socket → event log → runner queue → `RUN_COMPLETED` → observer → milestone.

1. `pnpm dev:api` and `pnpm dev:web`
2. Start a session, write a Python solution in Monaco, press Run
3. Confirm stdout appears in the output panel
4. Confirm a `RUN_COMPLETED` event was appended with non-zero `cpuTimeMs` and `memoryKb`
5. Write deliberately failing code, run it three times identically, and confirm a
   `REPEATED_SAME_FAILURE` milestone fires

Step 5 is the real test. It proves the runner is feeding the observer, which is what makes a
debugging probe defensible rather than improvised.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `status 13`, `rb_sysopen` errors | cgroup v1 not active. Back to §1. |
| Submissions queue but never finish | Workers raced the db. `docker compose down && docker compose up -d db redis && sleep 10 && docker compose up -d` |
| `?wait=true` returns an error | `ENABLE_WAIT_RESULT=false` in `judge0.conf` |
| Submission rejected on limits | Instance `MAX_*` caps are below what the adapter requests (§3) |
| Works in WSL, `runner: "none"` on Windows | `JUDGE0_URL` not in `apps/api/.env.local`, or the API wasn't restarted |
| `curl localhost:2358` works in WSL, fails from Windows | WSL localhost forwarding off. Add `localhostForwarding=true` under `[wsl2]` in `.wslconfig` |

---

## Done means

- [ ] All six attacks produce recorded, deterministic outcomes
- [ ] The network case **fails**
- [ ] Boot log shows `runner: "judge0"`
- [ ] A run from the browser produces a `RUN_COMPLETED` event with real CPU and memory
- [ ] Outcomes written to `docs/adr/`

At that point M0-2 closes and `Judge0Runner` stops being "written but unverified."
