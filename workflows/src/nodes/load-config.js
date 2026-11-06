// Reads sources.json and emits one item per approved feed for the HTTP fetch node.
const cfg = loadConfig($env.DSB_CONFIG_DIR || '/data/config');
const startedAt = new Date().toISOString();
const runId = startedAt.replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6);
const out = [];
for (const s of cfg.sources.sources) {
  if (s.status !== 'approved') continue;
  for (const f of s.feeds || []) {
    let url = f.url;
    if (url.includes('{{CONGRESS_API_KEY}}')) {
      if (!$env.CONGRESS_API_KEY) continue; // reported as "skipped" by the parse step
      url = url.replace('{{CONGRESS_API_KEY}}', encodeURIComponent($env.CONGRESS_API_KEY));
    }
    out.push({ json: { run_id: runId, started_at: startedAt, source_id: s.id, source_name: s.name, tier: s.tier, feed_url: url, feed_type: f.type } });
  }
}
if (!out.length) throw new Error('No approved feeds found in sources.json');
return out;
