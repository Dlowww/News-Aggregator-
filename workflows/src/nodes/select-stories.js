// Applies the relevance threshold, clusters coverage of the same event, applies the
// corroboration rules, ranks and caps stories, then fetches article text where robots.txt
// allows (rate-limited per host, no cookies, no paywall bypass). Emits one item per story.
const cfg = loadConfig($env.DSB_CONFIG_DIR || '/data/config');
const D = cfg.topics.digest;
const pol = cfg.sources.policy;
const srcById = Object.fromEntries(cfg.sources.sources.map((s) => [s.id, s]));
const all = $input.all().map((i) => i.json);
const stats = Object.assign({}, $('Prefilter & build classification requests').first().json.stats);
const classified = all.filter((x) => x.article && x.article.relevance);
stats.classified = classified.length;
stats.classification_retries = all.filter((x) => x.retried).length + all.filter((x) => x.failed).length;
stats.classification_failures = all.filter((x) => x.failed).length;
const thr = cfg.topics.classifier.relevance_threshold;
const relevant = classified.map((x) => x.article).filter((a) => a.relevance.relevant && a.relevance.score >= thr);
stats.relevance_pass = relevant.length;
const now = Date.now();
const clusters = clusterArticles(relevant, { threshold: cfg.topics.clustering.embedding_similarity_threshold, title_jaccard: cfg.topics.clustering.title_jaccard_threshold });
for (const c of clusters) {
  // Syndicated wire copy counts toward the wire service's owner group, not the republishing outlet.
  c.corroboration = corroboration({ members: c.members.map((m) => Object.assign({}, m)) }, Object.assign({}, srcById,
    Object.fromEntries(c.members.filter((m) => m.syndicated_from).map((m) => [m.source_id, Object.assign({}, srcById[m.source_id], { owner_group: m.owner_group })]))), pol);
  c.rank = rankScore(c, now);
}
stats.clusters = clusters.length;
clusters.sort((a, b) => b.rank - a.rank);
const main = clusters.filter((c) => c.corroboration.category === 'corroborated').slice(0, D.max_main_stories);
const prim = clusters.filter((c) => c.corroboration.category === 'primary').slice(0, D.max_primary_updates);
const single = clusters.filter((c) => c.corroboration.category === 'single').slice(0, D.max_single_source);
stats.clusters_corroborated = clusters.filter((c) => c.corroboration.category === 'corroborated').length;
stats.clusters_primary = clusters.filter((c) => c.corroboration.category === 'primary').length;
stats.clusters_single = clusters.filter((c) => c.corroboration.category === 'single').length;
const selected = [...main.map((c) => ['main', c]), ...prim.map((c) => ['primary', c]), ...single.map((c) => ['single', c])];
if (!selected.length) return [{ json: { no_stories: true, stats } }];

// Pick up to N members per story: one per outlet first, highest relevance first.
for (const [, c] of selected) {
  const byOutlet = new Map();
  for (const m of [...c.members].sort((a, b) => b.relevance.score - a.relevance.score)) if (!byOutlet.has(m.source_id)) byOutlet.set(m.source_id, m);
  c.summary_members = [...byOutlet.values()].slice(0, D.max_members_per_story);
}

// ---- full-text fetching (respecting robots.txt) ----
const UA = $env.SCRAPER_USER_AGENT || pol.scraping.user_agent;
const minGap = (pol.scraping.min_seconds_between_requests_per_host || 3) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const helpers = this.helpers;
async function get(url, tries) {
  for (let a = 0; a < tries; a++) {
    try { return await helpers.httpRequest({ method: 'GET', url, headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' }, timeout: 20000, json: false, encoding: 'utf8' }); }
    catch (e) {
      const code = e && (e.httpCode || (e.response && e.response.status) || (e.cause && e.cause.status));
      if (String(code) === '404' || String(code) === '403' || String(code) === '401' || a === tries - 1) throw e;
      await sleep(2000 * Math.pow(2, a)); // exponential backoff
    }
  }
}
const minChars = D.min_fulltext_chars || 800;
const jobs = [];
for (const [, c] of selected) for (const m of c.summary_members) {
  if ((m.content_text || '').length >= minChars) { m.full_text = m.content_text; m.full_text_source = 'feed'; continue; }
  jobs.push(m);
}
const byHost = new Map();
for (const m of jobs.slice(0, D.max_fulltext_fetches)) { let h; try { const u = new URL_(m.link); h = u.protocol + '//' + u.host; } catch (e) { continue; } if (!byHost.has(h)) byHost.set(h, []); byHost.get(h).push(m); }
stats.fulltext_from_feed = selected.reduce((s, [, c]) => s + c.summary_members.filter((m) => m.full_text_source === 'feed').length, 0);
stats.fulltext_fetched = 0; stats.fulltext_robots_disallowed = 0; stats.fulltext_failed = 0; stats.fulltext_too_short = 0;
await Promise.all([...byHost.entries()].map(async ([host, ms]) => {
  let robots;
  try { robots = parseRobots(await get(host + '/robots.txt', 2), UA); }
  catch (e) {
    const code = String(e && (e.httpCode || (e.response && e.response.status) || ''));
    if (code === '404' || code === '410') robots = { rules: [], crawlDelay: 0 }; // no robots.txt = allowed
    else { stats.fulltext_robots_disallowed += ms.length; return; } // cannot verify: do not fetch
  }
  const gap = Math.max(minGap, (robots.crawlDelay || 0) * 1000);
  for (const m of ms) {
    const u = new URL_(m.link);
    if (!robotsAllows(robots, u.pathname + u.search)) { stats.fulltext_robots_disallowed++; continue; }
    try {
      const html = await get(m.link, 2);
      const txt = extractArticleText(typeof html === 'string' ? html : String(html));
      if (txt.length >= minChars) { m.full_text = txt; m.full_text_source = 'page'; stats.fulltext_fetched++; }
      else stats.fulltext_too_short++; // paywall, script-rendered page, or very short item: use the excerpt
    } catch (e) { stats.fulltext_failed++; }
    await sleep(gap);
  }
}));

const model = $env.OLLAMA_MODEL;
const strip = (m) => { const o = Object.assign({}, m); delete o.embedding; delete o.content_text; delete o.kw; return o; };
return selected.map(([section, c], i) => {
  const story = { id: c.members[0].id, section, rank: Math.round(c.rank * 1000) / 1000, corroboration: c.corroboration,
    members: c.summary_members.map(strip), all_members: c.members.map((m) => ({ source_id: m.source_id, source_name: m.source_name, tier: m.tier, tier_label: m.tier_label, title: m.title, link: m.link, url_norm: m.url_norm, relevance: m.relevance })),
    alignment: alignment({ members: c.members }, cfg.topics) };
  story.based_on_excerpt = !story.members.some((m) => m.full_text);
  return { json: { story, summary_body: buildSummaryBody(story, cfg, model), stats: i === 0 ? stats : undefined } };
});
