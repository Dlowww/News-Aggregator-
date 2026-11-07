// Error Trigger: the daily workflow failed. Build a loud, specific alert.
const e = $input.first().json;
const ex = e.execution || {}; const err = ex.error || {};
const wf = (e.workflow && e.workflow.name) || 'Defense Strategy Brief';
const lines = [
  `The workflow "${wf}" failed and no digest was sent for this run.`,
  'Failed node: ' + (ex.lastNodeExecuted || err.node && err.node.name || 'unknown'),
  'Error: ' + (err.message || 'unknown error'),
  err.description ? 'Details: ' + err.description : null,
  ex.url ? 'Execution: ' + ex.url : (ex.id ? 'Execution ID: ' + ex.id : null),
  'Mode: ' + (ex.mode || 'unknown') + ' · Time: ' + fmtDateLA(new Date(), { dateStyle: 'medium', timeStyle: 'short' }),
  '',
  'Common causes: Ollama container down or model not pulled; Gmail app password revoked or changed (update GMAIL_APP_PASSWORD in .env and re-run setup.sh); Postgres unavailable; a config JSON file with a syntax error. See README > Troubleshooting.',
].filter((l) => l !== null);
return [{ json: { to: $env.ALERT_RECIPIENT || $env.DIGEST_RECIPIENT, subject: '[ALERT] Defense Strategy Brief run failed', text: lines.join('\n'), html: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1f2b">' + lines.map((l) => l ? escapeHtml(l).replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>') : '<br>').join('<br>') + '</div>' } }];
