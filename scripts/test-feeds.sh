#!/usr/bin/env bash
# Tests every approved feed in config/sources.json from this machine (same User-Agent as the workflow).
set -uo pipefail
cd "$(dirname "$0")/.."
UA="DefenseStrategyBrief/1.0 (personal news digest; self-hosted n8n)"
KEY="$(grep -E '^CONGRESS_API_KEY=' .env 2>/dev/null | cut -d= -f2-)"
python3 - <<'PY' > /tmp/dsb-feeds.tsv
import json
d = json.load(open('config/sources.json'))
for s in d['sources']:
    if s['status'] == 'approved':
        for f in s['feeds']:
            print(f"{s['name']}\t{f['type']}\t{f['url']}")
PY
ok=0; bad=0
while IFS=$'\t' read -r name type url; do
  if [[ "$url" == *"{{CONGRESS_API_KEY}}"* ]]; then
    [ -z "$KEY" ] && { printf 'SKIP  %-50s CONGRESS_API_KEY not set\n' "$name"; continue; }
    url="${url//\{\{CONGRESS_API_KEY\}\}/$KEY}"
  fi
  body=$(curl -sSL -m 30 -A "$UA" -w '\n%{http_code}' "$url" 2>&1); code="${body##*$'\n'}"; body="${body%$'\n'*}"
  case "$type" in
    rss) grep -qiE '<(rss|feed|rdf:RDF)[ >]' <<<"$body" && valid=1 || valid=0; n=$(grep -oiE '<(item|entry)[ >]' <<<"$body" | wc -l);;
    html_list) valid=$([ ${#body} -gt 2000 ] && echo 1 || echo 0); n="(html)";;
    api) grep -q '{' <<<"$body" && valid=1 || valid=0; n="(json)";;
  esac
  if [ "$code" = 200 ] && [ "$valid" = 1 ]; then ok=$((ok+1)); printf 'OK    %-50s %s items  %s\n' "$name" "$n" "${url%%api_key=*}";
  else bad=$((bad+1)); printf 'FAIL  %-50s HTTP %s  %s\n' "$name" "$code" "${url%%api_key=*}"; fi
done < /tmp/dsb-feeds.tsv
echo; echo "$ok OK, $bad failed"
[ "$bad" = 0 ]
