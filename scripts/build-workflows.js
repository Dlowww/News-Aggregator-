#!/usr/bin/env node
/* Builds the importable n8n workflow JSON files from workflows/src/.
 * Each Code node gets lib.js inlined, so the exported workflows are self-contained.
 * Run: node scripts/build-workflows.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'workflows', 'src');
const LIB = fs.readFileSync(path.join(SRC, 'lib.js'), 'utf8').replace(/^'use strict';\n/m, '').replace(/\nif \(typeof module !== 'undefined'\) \{[\s\S]*$/, '\n');
const code = (f) => `// ---- generated from workflows/src/nodes/${f} + lib.js by scripts/build-workflows.js; edit those files, not this node ----\n`
  + LIB + '\n// ===================== node logic =====================\n' + fs.readFileSync(path.join(SRC, 'nodes', f), 'utf8');

const IDS = { main: 'DSBriefMain00001', alerts: 'DSBriefAlerts001', pg: 'dsbPostgres00001', smtp: 'dsbSmtpGmail0001' };
const PG = { postgres: { id: IDS.pg, name: 'DSB Postgres' } };
const SMTP = { smtp: { id: IDS.smtp, name: 'DSB Gmail SMTP' } };
// Gmail SMTP with an app password (smtp.gmail.com:465). Sends multipart/alternative (HTML + plain text).
const emailNode = (name, pos, notes) => node(name, 'n8n-nodes-base.emailSend', 2.1, pos, {
  fromEmail: "={{ 'Defense Strategy Brief <' + $env.GMAIL_ADDRESS + '>' }}",
  toEmail: '={{ $json.to }}', subject: '={{ $json.subject }}', emailFormat: 'both',
  text: '={{ $json.text }}', html: '={{ $json.html }}', options: { appendAttribution: false } },
{ credentials: SMTP, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, notes });
let nid = 0;
const uuid = () => { nid++; return `00000000-0000-4000-8000-${String(nid).padStart(12, '0')}`; };

function node(name, type, typeVersion, position, parameters, extra) {
  return Object.assign({ id: uuid(), name, type, typeVersion, position, parameters: parameters || {} }, extra || {});
}
const codeNode = (name, file, pos, extra) => node(name, 'n8n-nodes-base.code', 2, pos, { jsCode: code(file) }, extra);
const ifNode = (name, pos, leftExpr, op) => node(name, 'n8n-nodes-base.if', 2.2, pos, {
  conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: uuid(), leftValue: leftExpr, rightValue: '', operator: op }], combinator: 'and' }, options: {} });
const isTrue = { type: 'boolean', operation: 'true', singleValue: true };
const ollama = (name, pos, bodyField) => node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, {
  method: 'POST', url: `={{ ($env.OLLAMA_BASE_URL || 'http://ollama:11434') + '/api/${bodyField === 'embed_body' ? 'embed' : 'chat'}' }}`,
  sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify($json.${bodyField}) }}`,
  options: { timeout: 900000, batching: { batch: { batchSize: 1, batchInterval: 0 } } },
}, { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: bodyField === 'embed_body' ? 'stopWorkflow' : 'continueRegularOutput',
  notes: 'Local inference can be slow on CPU: 15-minute timeout, 3 tries 5 s apart (n8n built-in retry).' });
const logQuery = `WITH ins AS (
  INSERT INTO sent_articles (url_norm, url, title, source_id, run_id)
  SELECT x->>'u', x->>'url', x->>'t', x->>'s', $2 FROM jsonb_array_elements($1::jsonb) x WHERE $4 = 'sent'
  ON CONFLICT (url_norm) DO NOTHING RETURNING 1)
INSERT INTO run_log (run_id, status, stats) VALUES ($2, $4, $3::jsonb)
ON CONFLICT (run_id) DO UPDATE SET status = EXCLUDED.status, stats = EXCLUDED.stats
RETURNING run_id, status, (SELECT count(*) FROM ins) AS urls_recorded;`;
const pgLog = (name, pos, srcExpr) => node(name, 'n8n-nodes-base.postgres', 2.6, pos, {
  operation: 'executeQuery', query: logQuery,
  options: { queryReplacement: `={{ [ JSON.stringify(${srcExpr}.sent_rows || []), ${srcExpr}.run_id || ${srcExpr}.stats.run_id, JSON.stringify(${srcExpr}.stats), ${srcExpr}.status ] }}` },
}, { credentials: PG, retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 });
const execAlerts = (name, pos) => node(name, 'n8n-nodes-base.executeWorkflow', 1.2, pos, {
  source: 'database', workflowId: { __rl: true, mode: 'id', value: IDS.alerts }, options: { waitForSubWorkflow: true } });

function connect(conns, from, to, outIdx = 0, inIdx = 0) {
  conns[from] = conns[from] || { main: [] };
  while (conns[from].main.length <= outIdx) conns[from].main.push([]);
  conns[from].main[outIdx].push({ node: to, type: 'main', index: inIdx });
}

/* ------------------------------- main workflow ------------------------------- */
function buildMain() {
  nid = 0;
  const X = 260;
  const n = [
    node('Every day 5:00 AM PT', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], { rule: { interval: [{ field: 'cronExpression', expression: '0 5 * * *' }] } },
      { notes: 'Schedule timezone = workflow setting America/Los_Angeles (also GENERIC_TIMEZONE).' }),
    node('Run now (manual test)', 'n8n-nodes-base.manualTrigger', 1, [0, 200]),
    codeNode('Load config & build feed list', 'load-config.js', [X, 100]),
    node('Fetch feeds', 'n8n-nodes-base.httpRequest', 4.2, [2 * X, 100], {
      url: '={{ $json.feed_url }}', sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'User-Agent', value: "={{ $env.SCRAPER_USER_AGENT || 'DefenseStrategyBrief/1.0 (personal news digest; self-hosted n8n)' }}" },
        { name: 'Accept', value: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, application/json;q=0.8, */*;q=0.5' }] },
      options: { timeout: 30000, redirect: { redirect: { followRedirects: true, maxRedirects: 5 } },
        response: { response: { responseFormat: 'text', outputPropertyName: 'body' } },
        batching: { batch: { batchSize: 4, batchInterval: 1000 } } },
    }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput',
      notes: 'Fetches feeds 4 at a time, 1 s between batches; 3 tries 5 s apart. Failed feeds continue and are counted.' }),
    codeNode('Parse feeds, 24h window, exclusions', 'parse-feeds.js', [3 * X, 100]),
    node('Load already-sent URLs', 'n8n-nodes-base.postgres', 2.6, [4 * X, 100], {
      operation: 'executeQuery', query: "SELECT url_norm FROM sent_articles WHERE sent_at > now() - interval '60 days';", options: {} },
    { credentials: PG, alwaysOutputData: true, retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 }),
    codeNode('Drop sent URLs & build embedding request', 'dedup-embed.js', [5 * X, 100]),
    ollama('Ollama: embeddings', [6 * X, 100], 'embed_body'),
    codeNode('Prefilter & build classification requests', 'prefilter.js', [7 * X, 100]),
    ifNode('Any candidates?', [8 * X, 100], '={{ $json.no_candidates }}', { type: 'boolean', operation: 'false', singleValue: true }),
    ollama('Ollama: classify', [9 * X, 0], 'classify_body'),
    codeNode('Validate classifications', 'validate-classify.js', [10 * X, 0]),
    ifNode('Classification needs retry?', [11 * X, 0], '={{ $json.needs_retry }}', isTrue),
    ollama('Ollama: classify (retry)', [12 * X, -150], 'retry_body'),
    codeNode('Validate classification retry', 'validate-classify-retry.js', [13 * X, -150]),
    node('Collect classifications', 'n8n-nodes-base.merge', 3.2, [14 * X, 0], {}),
    codeNode('Select stories & fetch article text', 'select-stories.js', [15 * X, 0]),
    ifNode('Any stories?', [16 * X, 0], '={{ $json.no_stories }}', { type: 'boolean', operation: 'false', singleValue: true }),
    ollama('Ollama: summarize', [17 * X, -100], 'summary_body'),
    codeNode('Validate summaries', 'validate-summary.js', [18 * X, -100]),
    ifNode('Summary needs retry?', [19 * X, -100], '={{ $json.needs_retry }}', isTrue),
    ollama('Ollama: summarize (retry)', [20 * X, -250], 'retry_body'),
    codeNode('Validate summary retry', 'validate-summary-retry.js', [21 * X, -250]),
    node('Collect summaries', 'n8n-nodes-base.merge', 3.2, [22 * X, -100], {}),
    codeNode('Compose email & run stats', 'compose-email.js', [23 * X, -100]),
    ifNode('Anything to send?', [24 * X, -100], '={{ $json.no_stories }}', { type: 'boolean', operation: 'false', singleValue: true }),
    ifNode('Dry run?', [25 * X, -100], '={{ $json.dry_run }}', isTrue),
    codeNode('Save preview to disk', 'save-preview.js', [26 * X, -250]),
    emailNode('Send digest (Gmail SMTP)', [26 * X, -50], 'Gmail SMTP with an app password; sends HTML with a plain-text alternative. 3 tries, 5 s apart.'),
    pgLog('Record sent URLs & run log', [27 * X, -100], "$('Compose email & run stats').first().json"),
    codeNode('Feed health check', 'health-check.js', [28 * X, -100]),
    execAlerts('Alert: too many feed failures', [29 * X, -100]),
    codeNode('No qualifying stories', 'no-stories.js', [17 * X, 300]),
    pgLog('Log run (no stories)', [19 * X, 300], "$('No qualifying stories').first().json"),
    execAlerts('Alert: no stories', [18 * X, 300]),
  ];
  const c = {};
  connect(c, 'Every day 5:00 AM PT', 'Load config & build feed list');
  connect(c, 'Run now (manual test)', 'Load config & build feed list');
  const chain = ['Load config & build feed list', 'Fetch feeds', 'Parse feeds, 24h window, exclusions', 'Load already-sent URLs', 'Drop sent URLs & build embedding request', 'Ollama: embeddings', 'Prefilter & build classification requests', 'Any candidates?'];
  for (let i = 0; i < chain.length - 1; i++) connect(c, chain[i], chain[i + 1]);
  connect(c, 'Any candidates?', 'Ollama: classify', 0);
  connect(c, 'Any candidates?', 'No qualifying stories', 1);
  connect(c, 'Ollama: classify', 'Validate classifications');
  connect(c, 'Validate classifications', 'Classification needs retry?');
  connect(c, 'Classification needs retry?', 'Ollama: classify (retry)', 0);
  connect(c, 'Classification needs retry?', 'Collect classifications', 1, 1);
  connect(c, 'Ollama: classify (retry)', 'Validate classification retry');
  connect(c, 'Validate classification retry', 'Collect classifications', 0, 0);
  connect(c, 'Collect classifications', 'Select stories & fetch article text');
  connect(c, 'Select stories & fetch article text', 'Any stories?');
  connect(c, 'Any stories?', 'Ollama: summarize', 0);
  connect(c, 'Any stories?', 'No qualifying stories', 1);
  connect(c, 'Ollama: summarize', 'Validate summaries');
  connect(c, 'Validate summaries', 'Summary needs retry?');
  connect(c, 'Summary needs retry?', 'Ollama: summarize (retry)', 0);
  connect(c, 'Summary needs retry?', 'Collect summaries', 1, 1);
  connect(c, 'Ollama: summarize (retry)', 'Validate summary retry');
  connect(c, 'Validate summary retry', 'Collect summaries', 0, 0);
  connect(c, 'Collect summaries', 'Compose email & run stats');
  connect(c, 'Compose email & run stats', 'Anything to send?');
  connect(c, 'Anything to send?', 'Dry run?', 0);
  connect(c, 'Anything to send?', 'No qualifying stories', 1);
  connect(c, 'Dry run?', 'Save preview to disk', 0);
  connect(c, 'Dry run?', 'Send digest (Gmail SMTP)', 1);
  connect(c, 'Save preview to disk', 'Record sent URLs & run log');
  connect(c, 'Send digest (Gmail SMTP)', 'Record sent URLs & run log');
  connect(c, 'Record sent URLs & run log', 'Feed health check');
  connect(c, 'Feed health check', 'Alert: too many feed failures');
  // The alert runs before logging so the alerts workflow receives the alert payload itself.
  connect(c, 'No qualifying stories', 'Alert: no stories');
  connect(c, 'Alert: no stories', 'Log run (no stories)');
  return { id: IDS.main, name: 'Defense Strategy Brief — Daily', nodes: n, connections: c, active: false, pinData: {},
    settings: { executionOrder: 'v1', timezone: 'America/Los_Angeles', errorWorkflow: IDS.alerts, saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all', saveManualExecutions: true, executionTimeout: -1 },
    meta: { templateCredsSetupCompleted: true }, tags: [] };
}

/* ------------------------------ alerts workflow ------------------------------ */
function buildAlerts() {
  nid = 1000;
  const X = 260;
  const n = [
    node('On workflow error', 'n8n-nodes-base.errorTrigger', 1, [0, 0]),
    codeNode('Format failure alert', 'alert-failure.js', [X, 0]),
    node('Called by daily workflow', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, [0, 200], { inputSource: 'passthrough' }),
    codeNode('Format warning alert', 'alert-warning.js', [X, 200]),
    node('Monthly on the 1st, 8:45 AM PT', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 400], { rule: { interval: [{ field: 'cronExpression', expression: '45 8 1 * *' }] } }),
    codeNode('Ratings re-verification reminder', 'alert-monthly.js', [X, 400]),
    ifNode('Dry run?', [2 * X, 200], "={{ String($env.DSB_DRY_RUN || '').toLowerCase() === 'true' }}", isTrue),
    codeNode('Save alert preview', 'save-preview.js', [3 * X, 100]),
    emailNode('Send alert email', [3 * X, 300], 'Alerts go to ALERT_RECIPIENT, or DIGEST_RECIPIENT if unset.'),
  ];
  // The alert preview writer stores alerts as alert-latest.* (the html field is present, so tag it).
  n.find((x) => x.name === 'Save alert preview').parameters.jsCode = n.find((x) => x.name === 'Save alert preview').parameters.jsCode.replace("const name = j.html ? 'digest' : 'alert';", "const name = 'alert';");
  const c = {};
  connect(c, 'On workflow error', 'Format failure alert');
  connect(c, 'Called by daily workflow', 'Format warning alert');
  connect(c, 'Monthly on the 1st, 8:45 AM PT', 'Ratings re-verification reminder');
  for (const f of ['Format failure alert', 'Format warning alert', 'Ratings re-verification reminder']) connect(c, f, 'Dry run?');
  connect(c, 'Dry run?', 'Save alert preview', 0);
  connect(c, 'Dry run?', 'Send alert email', 1);
  return { id: IDS.alerts, name: 'Defense Strategy Brief — Alerts', nodes: n, connections: c, active: false, pinData: {},
    settings: { executionOrder: 'v1', timezone: 'America/Los_Angeles', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all' }, meta: {}, tags: [] };
}

const outDir = path.join(ROOT, 'workflows');
const main = buildMain();
fs.writeFileSync(path.join(outDir, 'defense-brief-main.json'), JSON.stringify(main, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'defense-brief-alerts.json'), JSON.stringify(buildAlerts(), null, 2) + '\n');
// Syntax-check every Code node.
for (const wf of [main, buildAlerts()]) for (const nd of wf.nodes) if (nd.type === 'n8n-nodes-base.code') {
  try { new Function('$input', '$', '$env', `return (async () => {\n${nd.parameters.jsCode}\n})`); }
  catch (e) { console.error(`Syntax error in "${nd.name}": ${e.message}`); process.exit(1); }
}
console.log('Wrote workflows/defense-brief-main.json and workflows/defense-brief-alerts.json');
