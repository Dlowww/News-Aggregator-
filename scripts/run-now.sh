#!/usr/bin/env bash
# Run the daily brief immediately (same workflow the 5:00 AM schedule runs).
#   ./scripts/run-now.sh            send the email
#   ./scripts/run-now.sh --dry-run  write previews/digest-latest.{html,txt,json} instead; URLs are not marked as sent
# Note: CLI runs are "manual" executions, so the error workflow does not fire for them; this script
# reports failures itself. Scheduled runs use the error workflow.
set -euo pipefail
cd "$(dirname "$0")/.."
DRY=false; [ "${1:-}" = "--dry-run" ] && DRY=true
echo "Running Defense Strategy Brief now (dry run: $DRY). Local inference can take a while on CPU..."
start=$(date +%s)
if docker compose exec -T -e N8N_RUNNERS_BROKER_PORT=5690 -e DSB_DRY_RUN=$DRY n8n n8n execute --id=DSBriefMain00001 --rawOutput > previews/last-run-output.json 2> previews/last-run-errors.txt; then
  echo "Finished in $(( $(date +%s) - start ))s."
  if [ "$DRY" = true ]; then echo "Preview: previews/digest-latest.html (stats: previews/digest-latest.json)"; else echo "Email sent to the address in DIGEST_RECIPIENT. Check your inbox."; fi
  docker compose exec -T postgres psql -U "${POSTGRES_USER:-dsb}" -d dsb -c "SELECT * FROM run_summary LIMIT 1;" || true
else
  echo "RUN FAILED after $(( $(date +%s) - start ))s. Last error lines:"; grep -v -i license previews/last-run-errors.txt | grep -v '^\s*at ' | tail -15; exit 1
fi
