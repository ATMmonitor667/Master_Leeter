#!/usr/bin/env bash
#
# M0-2 — stand up Judge0 and attack it.
#
# Standing it up is the easy half. The half that matters is the five abuse
# cases at the end: a sandbox nobody has attacked is a sandbox whose behaviour
# is unknown, and candidate code is untrusted by definition (invariant 6).
#
#   bash scripts/judge0-setup.sh
#
# Linux or macOS. On Windows, run this inside WSL2 — Judge0 uses cgroups and
# isolate, and a native Docker Desktop attempt fails in confusing ways.

set -uo pipefail

VERSION="${JUDGE0_VERSION:-1.13.1}"
DIR="${JUDGE0_DIR:-$HOME/judge0-v$VERSION}"
URL="http://localhost:2358"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }

# ─── Preflight ───────────────────────────────────────────────────────────────

bold "Preflight"

if ! command -v docker >/dev/null 2>&1; then
  bad "docker not found. Install Docker, then re-run."
  exit 1
fi
ok "docker $(docker --version | sed 's/Docker version //;s/,.*//')"

if ! docker compose version >/dev/null 2>&1; then
  bad "docker compose (v2) not found."
  exit 1
fi
ok "docker compose available"

if ! docker info >/dev/null 2>&1; then
  bad "Docker daemon is not running. Start Docker Desktop and re-run."
  exit 1
fi
ok "docker daemon responding"

case "$(uname -s)" in
  Linux|Darwin) ok "platform $(uname -s)" ;;
  *) warn "Judge0 is only tested on Linux and macOS. Use WSL2 on Windows." ;;
esac

# ─── Install ─────────────────────────────────────────────────────────────────

bold "Judge0 v$VERSION"

if [ -d "$DIR" ]; then
  ok "already present at $DIR"
else
  # The release zip, not a git clone: master can carry config and migrations
  # that do not line up with the published images.
  echo "  downloading release zip…"
  cd "$(dirname "$DIR")" || exit 1
  curl -fsSL -o "judge0-v$VERSION.zip" \
    "https://github.com/judge0/judge0/releases/download/v$VERSION/judge0-v$VERSION.zip" || {
      bad "download failed"; exit 1; }
  unzip -q "judge0-v$VERSION.zip" || { bad "unzip failed"; exit 1; }
  rm -f "judge0-v$VERSION.zip"
  ok "unpacked to $DIR"
fi

cd "$DIR" || exit 1

if grep -qE '^(REDIS_PASSWORD|POSTGRES_PASSWORD)=.+' judge0.conf 2>/dev/null; then
  ok "passwords already set in judge0.conf"
else
  REDIS_PW=$(head -c 32 /dev/urandom | base64 | tr -d '\n/+=' | head -c 32)
  PG_PW=$(head -c 32 /dev/urandom | base64 | tr -d '\n/+=' | head -c 32)
  sed -i.bak "s/^REDIS_PASSWORD=.*/REDIS_PASSWORD=$REDIS_PW/" judge0.conf
  sed -i.bak "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$PG_PW/" judge0.conf
  rm -f judge0.conf.bak
  ok "generated passwords"
fi

# ─── Start ───────────────────────────────────────────────────────────────────

bold "Starting"

# The sleep is not superstition: the workers race the database and come up
# permanently broken if the db is not ready first.
docker compose up -d db redis >/dev/null 2>&1
echo "  waiting 10s for db and redis…"
sleep 10
docker compose up -d >/dev/null 2>&1
echo "  waiting 5s for workers…"
sleep 5

for i in $(seq 1 30); do
  if curl -fsS -m 3 "$URL/about" >/dev/null 2>&1; then
    ok "Judge0 responding at $URL"
    break
  fi
  [ "$i" -eq 30 ] && { bad "never came up. Try: cd $DIR && docker compose logs --tail=50"; exit 1; }
  sleep 2
done

# ─── The part that matters ───────────────────────────────────────────────────

bold "Attacking it"

submit() {
  curl -fsS -m 60 -X POST "$URL/submissions?base64_encoded=false&wait=true" \
    -H 'content-type: application/json' \
    -d "$1" 2>/dev/null
}

# $1 label, $2 source, $3 acceptable status ids (space separated), $4 why
attack() {
  local label="$1" src="$2" want="$3" why="$4"
  local payload result status desc

  payload=$(python3 - "$src" <<'PY'
import json, sys
print(json.dumps({
    "language_id": 71,
    "source_code": sys.argv[1],
    "cpu_time_limit": 5,
    "wall_time_limit": 10,
    "memory_limit": 262144,
    "max_processes_and_or_threads": 32,
    "enable_network": False,
}))
PY
)

  result=$(submit "$payload")
  if [ -z "$result" ]; then
    bad "$label — no response (this is itself a finding)"
    RESULTS+=("$label|NO_RESPONSE|$why")
    return
  fi

  status=$(echo "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",{}).get("id",""))' 2>/dev/null)
  desc=$(echo "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",{}).get("description",""))' 2>/dev/null)

  if echo " $want " | grep -q " $status "; then
    ok "$label → $desc (status $status)"
  else
    bad "$label → $desc (status $status) — expected one of: $want"
    warn "   $why"
  fi
  RESULTS+=("$label|$desc ($status)|$why")
}

RESULTS=()

# 3 Accepted · 4 Wrong Answer · 5 Time Limit · 6 Compile Error
# 7-12 runtime errors (SIGSEGV, SIGXFSZ, SIGFPE, SIGABRT, NZEC, Other)
attack "baseline"     'print("ok")'                                    "3 4"            "if this fails nothing else is meaningful"
attack "infinite loop" 'while True: pass'                              "5"              "must TIMEOUT, not hang the request"
attack "memory bomb"  'x = [0] * (10**9)'                              "7 8 9 10 11 12" "must be killed, not swap the host"
attack "fork bomb"    'import os
while True:
    os.fork()'                                                          "5 7 8 9 10 11 12" "PID limit must hold"
attack "network"      'import urllib.request
print(urllib.request.urlopen("http://example.com", timeout=5).status)' \
                                                                        "5 7 8 9 10 11 12" "MUST FAIL — invariant 6. If this prints 200, stop and fix the config."
attack "filesystem"   'print(open("/etc/passwd").read()[:40])'          "3 4 7 8 9 10 11 12" "note what happens; reading is less bad than writing"

# ─── Report ──────────────────────────────────────────────────────────────────

bold "Paste this back"

echo
echo "JUDGE0_URL=$URL"
echo "version=$VERSION"
echo
for row in "${RESULTS[@]}"; do
  IFS='|' read -r label outcome _ <<< "$row"
  printf "%-14s %s\n" "$label" "$outcome"
done
echo

bold "Next"
echo "  Add to apps/api/.env.local:"
echo "    JUDGE0_URL=$URL"
echo
echo "  Stop it later with:  cd $DIR && docker compose down"
