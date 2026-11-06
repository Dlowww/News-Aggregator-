// Drops URLs already sent in earlier digests, computes keyword hits, and builds one
// Ollama /api/embed request containing all priority descriptions + all articles.
const cfg = loadConfig($env.DSB_CONFIG_DIR || '/data/config');
const bundle = $('Parse feeds, 24h window, exclusions').first().json;
const sent = new Set($input.all().map((i) => i.json.url_norm).filter(Boolean));
const stats = Object.assign({}, bundle.stats);
const fresh = bundle.articles.filter((a) => !sent.has(a.url_norm));
stats.already_sent = bundle.articles.length - fresh.length;
stats.after_dedup = fresh.length;
for (const a of fresh) { const t = articleText(a); a.kw = keywordHits(t, cfg.topics); a.context = hasContext(t, cfg.topics); }
const pri = cfg.topics.priorities;
const input = [...pri.map((p) => 'clustering: ' + p.label + '. ' + p.description), ...fresh.map((a) => 'clustering: ' + articleText(a))];
return [{ json: { stats, articles: fresh, n_priorities: pri.length, embed_body: { model: $env.OLLAMA_EMBED_MODEL || 'nomic-embed-text', input, truncate: true, keep_alive: '10m' } } }];
