// Parses every fetched feed, keeps the last N hours, applies opinion/sponsored exclusions,
// normalizes URLs and de-duplicates within the run. Emits ONE bundle item {stats, articles}.
const cfg = loadConfig($env.DSB_CONFIG_DIR || '/data/config');
const pol = cfg.sources.policy;
const hours = (cfg.topics.digest && cfg.topics.digest.window_hours) || 24;
const srcById = Object.fromEntries(cfg.sources.sources.map((s) => [s.id, s]));
const now = Date.now();
const resp = $input.all();
const first = $('Load config & build feed list').first().json;
const stats = { run_id: first.run_id, started_at: first.started_at, feeds_total: resp.length, feeds_ok: 0, feeds_failed: 0, failed_feeds: [], skipped_feeds: [],
  articles_fetched: 0, in_window: 0, excluded: 0, excluded_reasons: {}, duplicates_in_run: 0, per_source: {} };
for (const s of cfg.sources.sources) if (s.status === 'approved') for (const f of s.feeds || []) if (f.url.includes('{{CONGRESS_API_KEY}}') && !$env.CONGRESS_API_KEY) stats.skipped_feeds.push(s.name + ' (CONGRESS_API_KEY not set in .env)');
const fail = (feed, why) => { stats.feeds_failed++; stats.failed_feeds.push({ source: feed.source_name, url: feed.feed_url.replace(/api_key=[^&]+/, 'api_key=***'), error: String(why).slice(0, 240) }); };
const WIRE = [[/\b(associated press|\(AP\)|AP —|AP -)\b/i, 'Associated Press'], [/\breuters\b/i, 'Thomson Reuters'], [/\bagence france-presse|\bAFP\b/, 'AFP']];
const seen = new Map();
const articles = [];
resp.forEach((it, i) => {
  const feed = $('Load config & build feed list').itemMatching(i).json;
  const body = it.json.body !== undefined ? it.json.body : it.json.data;
  if (it.json.error) return fail(feed, it.json.error.message || JSON.stringify(it.json.error));
  if (typeof body !== 'string' || !body.trim()) return fail(feed, 'empty response');
  let items = [];
  try {
    if (feed.feed_type === 'rss') { if (!looksLikeFeed(body)) return fail(feed, 'response is not an RSS/Atom feed'); items = parseFeed(body); }
    else if (feed.feed_type === 'html_list') { items = parseHtmlList(body, feed.source_id, feed.feed_url); if (!items.length) return fail(feed, 'no items parsed from list page (site layout may have changed)'); }
    else if (feed.feed_type === 'api') { items = parseCrsApi(body); }
    else return fail(feed, 'unknown feed type ' + feed.feed_type);
  } catch (e) { return fail(feed, 'parse error: ' + e.message); }
  stats.feeds_ok++;
  const s = srcById[feed.source_id];
  const ps = stats.per_source[s.name] = stats.per_source[s.name] || { fetched: 0, in_window: 0, kept: 0 };
  for (const a of items) {
    stats.articles_fetched++; ps.fetched++;
    if (!inWindow(a, now, hours)) continue;
    stats.in_window++; ps.in_window++;
    const why = exclusionReason(a, pol);
    if (why) { stats.excluded++; stats.excluded_reasons[why] = (stats.excluded_reasons[why] || 0) + 1; continue; }
    const url_norm = normalizeUrl(a.link);
    if (seen.has(url_norm)) { stats.duplicates_in_run++; continue; }
    // Wire copy republished by an allowlisted outlet is not independent corroboration.
    let owner = s.owner_group, syndicated_from = null;
    const byline = (a.author || '') + ' ' + (a.summary || '').slice(0, 80);
    if (s.tier !== 'wire' && s.tier !== 'primary') for (const [re, grp] of WIRE) if (re.test(byline)) { owner = grp; syndicated_from = grp; break; }
    const art = { id: stats.run_id + ':' + articles.length, source_id: s.id, source_name: s.name, tier: s.tier, tier_label: TIER_LABELS[s.tier] || s.tier,
      owner_group: owner, syndicated_from, title: a.title, link: a.link, url_norm, published: a.published, date_precision: a.date_precision,
      summary: a.summary, content_text: truncate(a.content_text || '', 6000), categories: (a.categories || []).slice(0, 8), type_label: a.type_label || null };
    seen.set(url_norm, true); articles.push(art); ps.kept++;
  }
});
stats.after_exclusions = articles.length;
return [{ json: { stats, articles } }];
