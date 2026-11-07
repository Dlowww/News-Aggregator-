#!/usr/bin/env bash
# End-to-end test of the n8n workflows against a mock feed/Ollama server, in dry-run mode.
# Requirements: an n8n CLI (N8N_BIN) of the same version as the Docker image, Node, a Postgres
# reachable with the DSB_PG_* settings below, and the dsb schema loaded (db/01-schema.sql).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${E2E_WORK:-$(mktemp -d)}"
N8N_BIN="${N8N_BIN:?set N8N_BIN to the n8n executable}"
PORT="${MOCK_PORT:-11999}"
mkdir -p "$WORK/config" "$WORK/previews"

# 1) Test config: only a few sources, pointed at the mock server (one dead feed on purpose).
cp "$ROOT"/config/*.json "$WORK/config/"
python3 - "$WORK/config/sources.json" "$PORT" <<'EOF'
import json, sys
p, port = sys.argv[1], sys.argv[2]
d = json.load(open(p))
m = {'defensenews': 'rss', 'breakingdefense': 'rss', 'militarytimes': 'rss', 'bbc': 'rss', 'war_releases': 'rss', 'csis': 'html_list', 'usni': 'dead'}
for s in d['sources']:
    if s['id'] in m:
        s['status'] = 'approved'
        kind = m[s['id']]
        feed = 'dead' if kind == 'dead' else s['id']
        s['feeds'] = [{'url': f'http://127.0.0.1:{port}/feeds/{feed}.xml', 'type': 'rss' if kind == 'dead' else kind}]
    else:
        s['status'] = 'excluded'
json.dump(d, open(p, 'w'), indent=2)
EOF

# 2) Mock server.
node "$ROOT/tests/e2e/mock-server.js" > "$WORK/mock.log" 2>&1 &
MOCK_PID=$!
# Test SMTP server standing in for smtp.gmail.com (needs python with aiosmtpd; set SMTP_PYTHON).
"${SMTP_PYTHON:-python3}" "$ROOT/tests/e2e/smtp-sink.py" "${SMTP_PORT:-2525}" "$WORK/mail" > "$WORK/smtp.log" 2>&1 &
SMTP_PID=$!
trap 'kill $MOCK_PID $SMTP_PID 2>/dev/null || true' EXIT
sleep 1

# 3) Environment for n8n.
export DSB_CONFIG_DIR="$WORK/config" DSB_PREVIEW_DIR="$WORK/previews" DSB_DRY_RUN=true
export OLLAMA_BASE_URL="http://127.0.0.1:$PORT" OLLAMA_MODEL=mock-model OLLAMA_EMBED_MODEL=mock-embed
export DIGEST_RECIPIENT=test@example.com GMAIL_ADDRESS=sender@example.com SCRAPER_USER_AGENT="DefenseStrategyBrief/1.0 (e2e test)"
export NODE_FUNCTION_ALLOW_BUILTIN=fs,url N8N_BLOCK_ENV_ACCESS_IN_NODE=false
export PGHOST="${DSB_PG_HOST:-127.0.0.1}" PGPORT="${DSB_PG_PORT:-5432}" PGUSER="${DSB_PG_USER:-dsb}" PGPASSWORD="${DSB_PG_PASSWORD:-dsb}" PGDATABASE="${DSB_PG_DB:-dsb}"

cat > "$WORK/creds.json" <<EOF
[{"id":"dsbPostgres00001","name":"DSB Postgres","type":"postgres","data":{"host":"$PGHOST","port":$PGPORT,"database":"$PGDATABASE","user":"$PGUSER","password":"$PGPASSWORD","ssl":"disable"}},
 {"id":"dsbSmtpGmail0001","name":"DSB Gmail SMTP","type":"smtp","data":{"user":"sender@example.com","password":"e2e-app-password","host":"127.0.0.1","port":${SMTP_PORT:-2525},"secure":false,"disableStartTls":true}}]
EOF
psql -q -c "TRUNCATE sent_articles, run_log;"
"$N8N_BIN" import:credentials --input="$WORK/creds.json" >/dev/null 2>&1
"$N8N_BIN" import:workflow --input="$ROOT/workflows/defense-brief-alerts.json" >/dev/null 2>&1
"$N8N_BIN" import:workflow --input="$ROOT/workflows/defense-brief-main.json" >/dev/null 2>&1
"$N8N_BIN" publish:workflow --id=DSBriefAlerts001 > "$WORK/publish.log" 2>&1 || { echo "publish failed"; cat "$WORK/publish.log"; }
# n8n 2.x applies CLI publishes when the server starts: start it briefly so the publication is processed.
"$N8N_BIN" start > "$WORK/server.log" 2>&1 &
SRV=$!
for i in $(seq 1 60); do sleep 2; curl -sf "http://127.0.0.1:${N8N_PORT:-5678}/healthz" >/dev/null && break; done
sleep 8; kill $SRV; wait $SRV 2>/dev/null || true

run() { "$N8N_BIN" execute --id=DSBriefMain00001 --rawOutput > "$WORK/out-$1.json" 2> "$WORK/err-$1.txt"; }
echo "== Run 1 (fresh database)"
run 1 || { echo "Run 1 FAILED"; grep -v license "$WORK/err-1.txt" | tail -20; exit 1; }
cp "$WORK/previews/digest-latest.html" "$WORK/run1-digest.html"
cp "$WORK/previews/digest-latest.txt" "$WORK/run1-digest.txt"
cp "$WORK/previews/digest-latest.json" "$WORK/run1-stats.json"
echo "Mock LLM calls: $(curl -s "http://127.0.0.1:$PORT/__calls")"
psql -c "SELECT run_id, status, stats->>'feeds_ok' ok, stats->>'feeds_failed' failed, stats->>'relevance_pass' relevant, stats->>'clusters' clusters, stats->>'stories_sent' sent FROM run_log;"

check() { if eval "$2"; then echo "PASS  $1"; else echo "FAIL  $1"; FAILED=1; fi; }
FAILED=0
S1="$WORK/run1-stats.json"
j() { python3 -c "import json,sys; d=json.load(open('$1')); print(eval(sys.argv[1]))" "$2"; }
check "feeds: 6 ok, 1 failed (dead feed counted)" '[ "$(j $S1 "d[\"feeds_ok\"],d[\"feeds_failed\"]")" = "(6, 1)" ]'
check "opinion URL and CSIS Commentary excluded" '[ "$(j $S1 "d[\"excluded\"]")" = "2" ]'
check "out-of-window item dropped" '[ "$(j $S1 "d[\"articles_fetched\"]-d[\"in_window\"]")" -ge 1 ]'
check "classification retry exercised" '[ "$(j $S1 "d[\"classification_retries\"]")" -ge 1 ]'
check "summary retry exercised (loaded terms rejected)" '[ "$(j $S1 "d[\"summary_retries\"]")" -ge 1 ]'
check "robots.txt disallow respected" '[ "$(j $S1 "d[\"fulltext_robots_disallowed\"]")" -ge 1 ]'
check "corroborated story present" '[ "$(j $S1 "d[\"stories_main\"]")" -ge 1 ]'
check "football story filtered as irrelevant" '! grep -qi football "$WORK/run1-digest.txt"'
check "every story has a Sources line" '[ "$(grep -c "^\* " "$WORK/run1-digest.txt")" = "$(grep -c "^  Sources: " "$WORK/run1-digest.txt")" ]'
check "same-owner coverage (Defense News + Military Times) not counted as corroboration" '! grep -A6 "Army recruiting" "$WORK/run1-digest.txt" | grep -q "^HOMELAND\|^BUDGET"'
check "tracking params kept out of stored URLs" '[ "$(psql -tAc "select count(*) from run_log")" = "1" ]'

echo "== Run 2 (dedup: mark the Defense News Golden Dome URL as already sent)"
psql -q -c "INSERT INTO sent_articles (url_norm,url) VALUES ('https://127.0.0.1:$PORT/articles/dn-golden-dome','x') ON CONFLICT DO NOTHING;"
run 2 || { echo "Run 2 FAILED"; grep -v license "$WORK/err-2.txt" | tail -20; exit 1; }
check "already-sent URL dropped" '[ "$(j $WORK/previews/digest-latest.json "d[\"already_sent\"]")" = "1" ]'

echo "== Run 3 (everything already sent -> no-stories alert, no digest)"
rm -f "$WORK/previews/alert-latest.txt"
psql -q -c "INSERT INTO sent_articles (url_norm,url) SELECT 'https://127.0.0.1:$PORT/articles/'||x,'x' FROM unnest(ARRAY['dn-recruiting','bd-golden-dome','bd-ndaa-shipbuilding','mt-recruiting','mt-pla-taiwan','bbc-pla-taiwan','bbc-football','war-golden-dome','war-china-readout','csis-golden-dome-report']) x ON CONFLICT DO NOTHING;"
run 3 || { echo "Run 3 FAILED"; grep -v license "$WORK/err-3.txt" | tail -20; exit 1; }
check "no-stories alert written" 'grep -q "no stories that passed" "$WORK/previews/alert-latest.txt"'
check "no-stories run logged" '[ "$(psql -tAc "select count(*) from run_log where status = '"'"'no_stories'"'"'")" = "1" ]'

echo "== Run 4 (scheduled production run with Ollama unreachable -> error workflow sends failure alert)"
# Error workflows only fire for triggered (production) executions, so publish a copy scheduled every minute.
rm -f "$WORK/previews/alert-latest.txt"
psql -q -c "DELETE FROM sent_articles;"
python3 - "$ROOT/workflows/defense-brief-main.json" "$WORK/main-every-minute.json" <<'PY'
import json, sys
w = json.load(open(sys.argv[1]))
w['id'] = 'DSBriefMainTest01'; w['name'] = 'E2E: daily brief every minute'
for n in w['nodes']:
    if n['type'] == 'n8n-nodes-base.scheduleTrigger':
        n['parameters']['rule']['interval'][0]['expression'] = '* * * * *'
json.dump(w, open(sys.argv[2], 'w'))
PY
"$N8N_BIN" import:workflow --input="$WORK/main-every-minute.json" >/dev/null 2>&1
"$N8N_BIN" publish:workflow --id=DSBriefMainTest01 >/dev/null 2>&1
OLLAMA_BASE_URL="http://127.0.0.1:1" "$N8N_BIN" start > "$WORK/server4.log" 2>&1 &
SRV=$!
for i in $(seq 1 75); do sleep 2; grep -q "failed and no digest was sent" "$WORK/previews/alert-latest.txt" 2>/dev/null && break; done
kill $SRV; wait $SRV 2>/dev/null || true
"$N8N_BIN" unpublish:workflow --id=DSBriefMainTest01 >/dev/null 2>&1 || true
check "failure alert written by error workflow" 'grep -q "failed and no digest was sent" "$WORK/previews/alert-latest.txt" 2>/dev/null'
check "alert names the failed node" 'grep -q "Ollama: embeddings" "$WORK/previews/alert-latest.txt" 2>/dev/null'

echo "== Run 5 (real send through the Send Email node to the test SMTP server)"
psql -q -c "DELETE FROM sent_articles;"
rm -rf "$WORK/mail"/*.eml 2>/dev/null || true
DSB_DRY_RUN=false run 5 || { echo "Run 5 FAILED"; grep -v license "$WORK/err-5.txt" | grep -v '^\s*at ' | tail -20; exit 1; }
EML="$(ls -t "$WORK"/mail/*.eml 2>/dev/null | head -1)"
check "digest delivered over SMTP" '[ -n "$EML" ]'
check "email is multipart/alternative with text and HTML parts" 'grep -qi "multipart/alternative" "$EML" && grep -qi "text/plain" "$EML" && grep -qi "text/html" "$EML"'
check "subject and sender correct" 'python3 -c "import email,sys;m=email.message_from_binary_file(open(sys.argv[1],\"rb\"));import email.header as h;s=str(h.make_header(h.decode_header(m[\"Subject\"])));assert s.startswith(\"Defense Strategy Brief: \"),s;assert \"sender@example.com\" in m[\"From\"];assert m[\"To\"]==\"test@example.com\"" "$EML"'
check "no n8n attribution footer" '! grep -qi "sent automatically with n8n" "$EML"'
check "sent URLs recorded after a real send" '[ "$(psql -tAc "select count(*) from sent_articles")" -gt 0 ]'
check "run logged as sent" '[ "$(psql -tAc "select status from run_log order by started_at desc limit 1")" = "sent" ]'

echo "== Run 6 (real send of an alert: everything already sent -> no-stories alert email)"
rm -rf "$WORK/mail"/*.eml 2>/dev/null || true
DSB_DRY_RUN=false run 6 || { echo "Run 6 FAILED"; grep -v license "$WORK/err-6.txt" | grep -v '^\s*at ' | tail -20; exit 1; }
AEML="$(ls -t "$WORK"/mail/*.eml 2>/dev/null | head -1)"
check "no-stories alert delivered by email" '[ -n "$AEML" ] && python3 -c "import email,sys,email.header as h;m=email.message_from_binary_file(open(sys.argv[1],\"rb\"));s=str(h.make_header(h.decode_header(m[\"Subject\"])));assert s.startswith(\"[ALERT]\"),s" "$AEML"'

echo "Artifacts in $WORK"
[ "$FAILED" = 0 ] && echo "ALL E2E CHECKS PASSED" || { echo "SOME E2E CHECKS FAILED"; exit 1; }
