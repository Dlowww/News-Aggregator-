#!/usr/bin/env bash
# Defense Strategy Brief: one-time setup (safe to re-run).
#   1. creates .env and generates secrets       5. creates the n8n owner account
#   2. detects RAM/GPU and picks an Ollama model 6. imports credentials (Postgres; Gmail SMTP)
#   3. starts Postgres, Ollama, n8n             7. imports + publishes both workflows
#   4. pulls the models                          8. prints how to test
# Options: --no-pull (skip model downloads)
set -euo pipefail
cd "$(dirname "$0")"
PULL=1
for a in "$@"; do case "$a" in --reimport-credentials) ;; --no-pull) PULL=0;; *) echo "unknown option $a"; exit 2;; esac; done

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARNING: %s\033[0m\n' "$*"; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

env_get() { [ -f .env ] || return 0; grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'; }
env_set() {
  local k="$1" v="$2"
  if grep -qE "^$k=" .env; then
    python3 - "$k" "$v" <<'PY'
import sys, re
k, v = sys.argv[1], sys.argv[2]
s = open('.env').read()
s = re.sub(r'(?m)^' + re.escape(k) + r'=.*$', lambda m: k + '=' + v, s)
open('.env', 'w').write(s)
PY
  else printf '%s=%s\n' "$k" "$v" >> .env; fi
}
rand() { openssl rand -hex "${1:-24}" 2>/dev/null || python3 -c "import secrets;print(secrets.token_hex(${1:-24}))"; }

# ---------------------------------------------------------------- prerequisites
say "Checking prerequisites"
command -v docker >/dev/null || die "Docker is not installed (https://docs.docker.com/get-docker/)."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required ('docker compose')."
docker info >/dev/null 2>&1 || die "Docker daemon is not running."
command -v curl >/dev/null || die "curl is required."
command -v python3 >/dev/null || die "python3 is required (used to edit .env and JSON safely)."
node -e 'process.exit(0)' 2>/dev/null && node scripts/build-workflows.js >/dev/null && echo "Rebuilt workflow JSON from workflows/src."

# ---------------------------------------------------------------- .env
say "Configuring .env"
[ -f .env ] || { cp .env.example .env; echo "Created .env from .env.example"; }
chmod 600 .env
[ -n "$(env_get POSTGRES_PASSWORD)" ] || env_set POSTGRES_PASSWORD "$(rand 18)"
[ -n "$(env_get N8N_ENCRYPTION_KEY)" ] || { env_set N8N_ENCRYPTION_KEY "$(rand 24)"; warn "Generated N8N_ENCRYPTION_KEY. Back up .env: without this key stored credentials cannot be decrypted."; }
ask() { # ask KEY "prompt" [secret]
  local cur; cur="$(env_get "$1")"
  if [ -z "$cur" ] || [ "$cur" = "you@example.com" ]; then
    if [ -t 0 ]; then
      if [ "${3:-}" = secret ]; then read -r -s -p "$2: " cur; echo; else read -r -p "$2: " cur; fi
      env_set "$1" "$cur"
    else die "$1 is not set in .env (run interactively or edit .env)"; fi
  fi
}
ask DIGEST_RECIPIENT "Email address to receive the daily brief"
ask N8N_OWNER_EMAIL "n8n owner account email (for logging in to n8n)"
ask N8N_OWNER_PASSWORD "n8n owner password (8+ chars, a number and an uppercase letter)" secret
ask GMAIL_ADDRESS "Gmail address that will SEND the digest"
ask GMAIL_APP_PASSWORD "Gmail app password for that account (16 characters, from https://myaccount.google.com/apppasswords)" secret
env_set GMAIL_APP_PASSWORD "$(env_get GMAIL_APP_PASSWORD | tr -d ' ')"   # Google displays it in groups of four
APPPW="$(env_get GMAIL_APP_PASSWORD)"
[ "${#APPPW}" -eq 16 ] || warn "GMAIL_APP_PASSWORD is ${#APPPW} characters; Gmail app passwords are 16. Check .env if sending fails."

# ---------------------------------------------------------------- hardware detection
say "Detecting hardware"
OS="$(uname -s)"
if [ "$OS" = Darwin ]; then RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ));
elif [ -r /proc/meminfo ]; then RAM_GB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1048576 ));
else RAM_GB=0; fi
DOCKER_MEM_GB=$(( $(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0) / 1073741824 ))
CPUS=$(docker info --format '{{.NCPU}}' 2>/dev/null || echo "?")
VRAM_GB=0; GPU_NAME="none"; GPU_USABLE=0
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
  VRAM_GB=$(( $(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | sort -n | tail -1) / 1024 ))
  if docker info 2>/dev/null | grep -qi nvidia; then GPU_USABLE=1; else warn "NVIDIA GPU found but the NVIDIA Container Toolkit is not configured for Docker; using CPU. Install it and re-run setup to use the GPU."; fi
fi
echo "Host RAM: ${RAM_GB} GB · RAM available to Docker: ${DOCKER_MEM_GB} GB · CPUs: ${CPUS} · GPU: ${GPU_NAME} (${VRAM_GB} GB VRAM, usable in Docker: $([ $GPU_USABLE = 1 ] && echo yes || echo no))"
[ "$OS" = Darwin ] && echo "macOS: Docker cannot use the Apple GPU, so Ollama-in-Docker runs on CPU. See README for using native Ollama instead."
EFF_RAM=$DOCKER_MEM_GB; [ "$EFF_RAM" -gt 0 ] || EFF_RAM=$RAM_GB

if [ -n "$(env_get OLLAMA_MODEL)" ]; then
  MODEL="$(env_get OLLAMA_MODEL)"; echo "Using OLLAMA_MODEL=$MODEL from .env (delete it to auto-select)."
else
  if   [ $GPU_USABLE = 1 ] && [ $VRAM_GB -ge 12 ]; then MODEL=qwen2.5:14b; WHY="GPU with ${VRAM_GB} GB VRAM fits the 14B model (~9 GB at Q4) entirely in VRAM: best summary quality at good speed."
  elif [ $GPU_USABLE = 1 ] && [ $VRAM_GB -ge 6 ];  then MODEL=llama3.1:8b; WHY="GPU with ${VRAM_GB} GB VRAM fits an 8B model (~5 GB) but not the 14B; partial CPU offload of a 14B would be several times slower."
  elif [ $EFF_RAM -ge 30 ]; then MODEL=qwen2.5:14b; WHY="No usable GPU, but ${EFF_RAM} GB RAM fits the 14B model. CPU inference is slow (expect roughly 30-90 minutes per daily run) but runs unattended at 5 AM; switch to llama3.1:8b if it does not finish in time."
  elif [ $EFF_RAM -ge 14 ]; then MODEL=llama3.1:8b; WHY="No usable GPU and ${EFF_RAM} GB RAM: the 8B model (~5 GB) leaves room for n8n and Postgres; the 14B (~9 GB + context) would risk swapping."
  else MODEL=qwen2.5:3b; WHY="Only ${EFF_RAM} GB RAM available to Docker: a 3B model is the largest that fits reliably. Summary quality will be noticeably lower; give Docker more memory and re-run setup to upgrade."; fi
  env_set OLLAMA_MODEL "$MODEL"
  echo "Selected OLLAMA_MODEL=$MODEL"; echo "Why: $WHY"
fi
[ -n "$(env_get OLLAMA_EMBED_MODEL)" ] || env_set OLLAMA_EMBED_MODEL nomic-embed-text
if [ $GPU_USABLE = 1 ]; then env_set COMPOSE_FILE "docker-compose.yml:docker-compose.gpu.yml"; else env_set COMPOSE_FILE "docker-compose.yml"; fi

# ---------------------------------------------------------------- start services
PGUSER="$(env_get POSTGRES_USER)"; PGUSER="${PGUSER:-dsb}"
say "Starting Postgres and Ollama"
mkdir -p previews .setup && chmod 777 previews
docker compose up -d postgres ollama
for i in $(seq 1 60); do docker compose exec -T postgres pg_isready -U "$PGUSER" -d dsb >/dev/null 2>&1 && break; sleep 2; [ "$i" = 60 ] && die "Postgres did not become ready (docker compose logs postgres)"; done
for i in $(seq 1 60); do docker compose exec -T ollama ollama list >/dev/null 2>&1 && break; sleep 2; [ "$i" = 60 ] && die "Ollama did not become ready (docker compose logs ollama)"; done
if [ $GPU_USABLE = 1 ]; then docker compose logs ollama 2>&1 | grep -qiE "inference compute.*(cuda|gpu)" && echo "Ollama sees the GPU." || warn "Could not confirm Ollama is using the GPU; check 'docker compose logs ollama'."; fi

if [ $PULL = 1 ]; then
  say "Pulling models (first run downloads several GB)"
  docker compose exec -T ollama ollama pull "$(env_get OLLAMA_MODEL)"
  docker compose exec -T ollama ollama pull "$(env_get OLLAMA_EMBED_MODEL)"
fi

say "Starting n8n"
docker compose up -d n8n
PORT="$(env_get N8N_PORT)"; PORT="${PORT:-5678}"; BASE="http://127.0.0.1:$PORT"
for i in $(seq 1 90); do curl -sf "$BASE/healthz" >/dev/null 2>&1 && break; sleep 2; [ "$i" = 90 ] && die "n8n did not start (docker compose logs n8n)"; done
echo "n8n is up at $BASE"

say "Creating n8n owner account"
OWNER_JSON=$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"firstName":"Digest","lastName":"Owner","password":sys.argv[2]}))' "$(env_get N8N_OWNER_EMAIL)" "$(env_get N8N_OWNER_PASSWORD)")
CODE=$(curl -s -o .setup/owner.json -w '%{http_code}' -X POST "$BASE/rest/owner/setup" -H 'Content-Type: application/json' -d "$OWNER_JSON")
if [ "$CODE" = 200 ]; then echo "Owner account created for $(env_get N8N_OWNER_EMAIL)."
elif grep -qi "already" .setup/owner.json 2>/dev/null; then echo "Owner account already exists."
else warn "Owner setup returned HTTP $CODE: $(head -c 300 .setup/owner.json). If an owner already exists this is fine; otherwise create it at $BASE."; fi
rm -f .setup/owner.json

say "Importing credentials"
n8n_cli() { docker compose exec -T -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n "$@"; }
# Both credentials come from .env, so they are re-imported on every run: change .env, then re-run setup.
python3 - "$PGUSER" "$(env_get POSTGRES_PASSWORD)" "$(env_get GMAIL_ADDRESS)" "$(env_get GMAIL_APP_PASSWORD)" > .setup/creds.json <<'PY'
import json, sys
u, pw, gaddr, gpw = sys.argv[1:5]
print(json.dumps([
  {"id": "dsbPostgres00001", "name": "DSB Postgres", "type": "postgres",
   "data": {"host": "postgres", "port": 5432, "database": "dsb", "user": u, "password": pw, "ssl": "disable"}},
  {"id": "dsbSmtpGmail0001", "name": "DSB Gmail SMTP", "type": "smtp",
   "data": {"user": gaddr, "password": gpw, "host": "smtp.gmail.com", "port": 465, "secure": True}}]))
PY
chmod 600 .setup/creds.json
docker compose cp .setup/creds.json n8n:/tmp/creds.json >/dev/null
n8n_cli import:credentials --input=/tmp/creds.json | grep -v -i license || true
docker compose exec -T n8n rm -f /tmp/creds.json; rm -f .setup/creds.json

say "Importing and publishing workflows"
n8n_cli import:workflow --input=/data/workflows/defense-brief-alerts.json | grep -v -i license || true
n8n_cli import:workflow --input=/data/workflows/defense-brief-main.json | grep -v -i license || true
n8n_cli publish:workflow --id=DSBriefAlerts001 | grep -v -i -E 'license|^Note|restart' || true
n8n_cli publish:workflow --id=DSBriefMain00001 | grep -v -i -E 'license|^Note|restart' || true
docker compose restart n8n >/dev/null   # publications take effect on restart
for i in $(seq 1 90); do curl -sf "$BASE/healthz" >/dev/null 2>&1 && break; sleep 2; done

PUBLIC_URL="$(env_get N8N_PUBLIC_URL)"; PUBLIC_URL="${PUBLIC_URL:-http://localhost:$PORT/}"
say "Setup complete"
cat <<EOF
Model: $(env_get OLLAMA_MODEL) (+ $(env_get OLLAMA_EMBED_MODEL) for embeddings) · Schedule: daily 5:00 AM America/Los_Angeles

Next steps:
  1. Optional: add CONGRESS_API_KEY to .env, then run: docker compose up -d n8n
  2. Test without sending: ./scripts/run-now.sh --dry-run   (writes previews/digest-latest.html)
  3. Send a real digest:   ./scripts/run-now.sh   (from $(env_get GMAIL_ADDRESS) to $(env_get DIGEST_RECIPIENT))
  n8n is at $BASE (log in as $(env_get N8N_OWNER_EMAIL)); there is nothing to configure there.
EOF
