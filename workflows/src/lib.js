/* Defense Strategy Brief: shared logic for n8n Code nodes.
 * This file is inlined into every Code node by scripts/build-workflows.js,
 * and is also loaded directly by tests/run-tests.js. Keep it dependency-free.
 */
'use strict';

// The n8n Code-node sandbox has no global URL; fall back to Node's url module (allowed via NODE_FUNCTION_ALLOW_BUILTIN=fs,url).
const URL_ = typeof URL !== 'undefined' ? URL : require('url').URL;
const CONFIG_DIR = (typeof process !== 'undefined' && process.env && process.env.DSB_CONFIG_DIR) || '/data/config';

function loadConfig(dir) {
  const fs = require('fs');
  const d = dir || CONFIG_DIR;
  const read = (f) => JSON.parse(fs.readFileSync(d + '/' + f, 'utf8'));
  return { sources: read('sources.json'), topics: read('topics.json'), prompts: read('prompts.json') };
}

/* ---------------- text helpers ---------------- */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', bull: '•', middot: '·' };
function decodeEntities(s) {
  if (!s) return '';
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}
function stripCdata(s) { return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'); }
function stripTags(s) {
  return String(s || '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ').replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}
function cleanText(s) { return decodeEntities(stripTags(decodeEntities(stripCdata(s)))).replace(/\s+/g, ' ').trim(); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }

/* ---------------- feed parsing ---------------- */
function tagContent(block, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = block.match(re);
  return m ? stripCdata(m[1]).trim() : '';
}
function allTagContents(block, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'gi');
  const out = []; let m;
  while ((m = re.exec(block))) out.push(cleanText(m[1]));
  return out.filter(Boolean);
}
function toIso(d) {
  if (!d) return null;
  const t = Date.parse(String(d).trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function looksLikeFeed(body) { return /<(rss|feed|rdf:RDF)[\s>]/i.test(String(body || '').slice(0, 5000)); }

function parseFeed(xml) {
  xml = String(xml || '');
  const items = [];
  const isAtom = /<feed[\s>]/i.test(xml.slice(0, 3000)) && !/<rss[\s>]/i.test(xml.slice(0, 3000));
  const blockRe = isAtom ? /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi : /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = blockRe.exec(xml))) {
    const b = m[1];
    let link = '';
    if (isAtom) {
      const lm = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = lm ? lm[1] : '';
    } else {
      link = cleanText(tagContent(b, 'link'));
      if (!link) { const g = b.match(/<guid[^>]*isPermaLink=["']true["'][^>]*>([\s\S]*?)<\/guid>/i); if (g) link = cleanText(g[1]); }
    }
    const date = tagContent(b, 'pubDate') || tagContent(b, 'published') || tagContent(b, 'updated') || tagContent(b, 'dc:date');
    const summaryRaw = tagContent(b, 'description') || tagContent(b, 'summary');
    const contentRaw = tagContent(b, 'content:encoded') || tagContent(b, 'content');
    items.push({
      title: cleanText(tagContent(b, 'title')),
      link: decodeEntities(link.trim()),
      published: toIso(cleanText(date)),
      date_precision: 'time',
      summary: truncate(cleanText(summaryRaw), 1200),
      content_text: contentRaw ? cleanText(contentRaw) : '',
      categories: allTagContents(b, 'category'),
      author: cleanText(tagContent(b, 'dc:creator') || tagContent(b, 'author')),
    });
  }
  return items.filter((i) => i.title && i.link);
}

function absUrl(href, base) { try { return new URL_(decodeEntities(href), base).toString(); } catch (e) { return href; } }

/* HTML list pages (no RSS available). Each parser is specific to one site's markup. */
function parseHtmlList(html, sourceId, baseUrl) {
  html = String(html || '');
  const out = [];
  if (sourceId === 'hasc') {
    const re = /<article class="newsblocker">([\s\S]*?)<\/article>/gi; let m;
    while ((m = re.exec(html))) {
      const b = m[1];
      const a = b.match(/<h2[^>]*class="newsie-titler"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const t = b.match(/<time[^>]*datetime="([^"]+)"/i);
      const body = b.match(/<div class="newsbody">([\s\S]*?)<\/div>/i);
      const cat = b.match(/<span class="cattype">([\s\S]*?)<\/span>/i);
      if (!a) continue;
      out.push({ title: cleanText(a[2]), link: absUrl(a[1], baseUrl), published: t ? toIso(t[1] + 'T12:00:00-05:00') : null, date_precision: 'day',
        summary: truncate(cleanText(body ? body[1] : '').replace(/Read more »/g, '').trim(), 1200), content_text: '', categories: cat ? [cleanText(cat[1]).replace(/^\|\s*Posted in\s*/i, '')] : [], author: 'House Armed Services Committee' });
    }
  } else if (sourceId === 'sasc') {
    const re = /<li[^>]*class="[^"]*PageList__item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi; let m;
    while ((m = re.exec(html))) {
      const b = m[1];
      const a = b.match(/<a[^>]*href="([^"]*\/press-releases\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const d = b.match(/<p class="Heading Heading--time[^"]*">([\s\S]*?)<\/p>/i);
      const ex = b.match(/<div class="ArticleBlock__excerpt">([\s\S]*?)<\/div>/i);
      if (!a) continue;
      const dateStr = d ? cleanText(d[1]) : '';
      out.push({ title: cleanText(a[2]), link: absUrl(a[1], baseUrl), published: dateStr ? toIso(dateStr + ' 12:00:00 EST') : null, date_precision: 'day',
        summary: truncate(cleanText(ex ? ex[1] : ''), 1200), content_text: '', categories: ['Press Releases'], author: 'Senate Armed Services Committee' });
    }
  } else if (sourceId === 'csis') {
    const re = /<article class="article-search-listing[^"]*"[^>]*>([\s\S]*?)<\/article>/gi; let m;
    while ((m = re.exec(html))) {
      const b = m[1];
      const a = b.match(/<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const sum = b.match(/<div class="search-listing--summary[^"]*">([\s\S]*?)<\/div>/i);
      const cred = b.match(/<div class="contributors credit[^"]*">([\s\S]*?)<\/div>/i);
      if (!a) continue;
      const credText = cleanText(cred ? cred[1] : '');
      const typeLabel = (credText.match(/^([A-Z][A-Za-z ]+?)(?:\s+by\b|\s+—)/) || [])[1] || '';
      const dateStr = (credText.match(/—\s*([A-Z][a-z]+ \d{1,2}, \d{4})/) || [])[1] || '';
      out.push({ title: cleanText(a[2]), link: absUrl(a[1], baseUrl), published: dateStr ? toIso(dateStr + ' 12:00:00 EST') : null, date_precision: 'day',
        summary: truncate(cleanText(sum ? sum[1] : ''), 1200), content_text: '', categories: typeLabel ? [typeLabel.trim()] : [], type_label: typeLabel.trim(), author: 'CSIS' });
    }
  }
  return out.filter((i) => i.title && i.link);
}

/* Congress.gov CRS reports API. Tolerant of field-name variations. */
function parseCrsApi(body) {
  let j = body;
  if (typeof body === 'string') { try { j = JSON.parse(body); } catch (e) { return []; } }
  if (!j || typeof j !== 'object') return [];
  const key = Object.keys(j).find((k) => /crs/i.test(k) && Array.isArray(j[k]));
  const arr = key ? j[key] : (Array.isArray(j.reports) ? j.reports : []);
  return arr.map((r) => {
    const id = r.id || r.reportNumber || r.number || '';
    const link = (r.url && /congress\.gov\/crs/i.test(r.url) && !/api\.congress\.gov/i.test(r.url)) ? r.url : (id ? 'https://www.congress.gov/crs-product/' + id : '');
    return { title: cleanText(r.title || ''), link, published: toIso(r.publishDate || r.updateDate || r.date), date_precision: 'time',
      summary: truncate(cleanText(r.summary || ''), 1200), content_text: '', categories: [r.contentType || r.type || 'CRS Report'].filter(Boolean), author: 'Congressional Research Service' };
  }).filter((i) => i.title && i.link);
}

/* ---------------- URL normalization & filtering ---------------- */
const TRACKING_PARAMS = /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|at_medium|at_campaign|at_link_id|at_link_origin|at_ptr_name|at_format|cmpid|cmp|ocid|smid|taid|_ga|_gl|ref|ref_src|src|source|campaign|guccounter|sh|soc_src|soc_trk|share|igshid|mkt_tok|rss|ito|xid|traffic_source|tpcc|sr_share|partner|feature)$/i;
function normalizeUrl(u) {
  try {
    const url = new URL_(String(u).trim());
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
    url.protocol = 'https:';
    const keep = [];
    url.searchParams.forEach((v, k) => { if (!TRACKING_PARAMS.test(k)) keep.push([k, v]); });
    keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    url.search = keep.length ? '?' + keep.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&') : '';
    let p = url.pathname.replace(/\/{2,}/g, '/');
    if (p.length > 1) p = p.replace(/\/+$/, '');
    url.pathname = p;
    return url.toString();
  } catch (e) { return String(u || '').trim(); }
}
function exclusionReason(item, policy) {
  const ex = (policy && policy.exclusions) || {};
  const link = String(item.link || '').toLowerCase();
  for (const p of ex.url_patterns || []) if (link.includes(p.toLowerCase())) return 'url:' + p;
  const cats = (item.categories || []).map((c) => c.toLowerCase().trim());
  for (const c of ex.feed_categories || []) if (cats.includes(c.toLowerCase())) return 'category:' + c;
  for (const t of ex.title_prefixes || []) if (String(item.title || '').startsWith(t)) return 'title:' + t;
  if (item.type_label) for (const l of policy.html_list_exclude_type_labels || []) if (item.type_label.toLowerCase() === l.toLowerCase()) return 'type:' + l;
  return null;
}
function inWindow(item, nowMs, hours) {
  if (!item.published) return false;
  const t = Date.parse(item.published);
  if (!Number.isFinite(t)) return false;
  const day = item.date_precision === 'day';
  // Day-precision dates (list pages) are stamped at noon Eastern, which can be "in the future" early in the day.
  if (t > nowMs + (day ? 24 : 2) * 3600e3) return false; // future-dated
  const slack = day ? 12 * 3600e3 : 0;
  return nowMs - Math.min(t, nowMs) <= hours * 3600e3 + slack;
}

/* ---------------- relevance prefilter ---------------- */
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function keywordRegex(k) {
  if (k.length > 2 && k[0] === '/' && k[k.length - 1] === '/') return new RegExp(k.slice(1, -1), 'i');
  const caseSensitive = /^[A-Z0-9-]{2,5}$/.test(k); // short acronyms: avoid matching common words
  return new RegExp('(^|[^A-Za-z0-9])' + escapeRe(k) + '(?=$|[^A-Za-z0-9])', caseSensitive ? '' : 'i');
}
const _reCache = new Map();
function kwMatch(text, k) { let re = _reCache.get(k); if (!re) { re = keywordRegex(k); _reCache.set(k, re); } return re.test(text); }
function keywordHits(text, topics) {
  const hits = {};
  for (const p of topics.priorities) {
    const h = p.keywords.filter((k) => kwMatch(text, k));
    if (h.length) hits[p.id] = h;
  }
  return hits;
}
function hasContext(text, topics) { return (topics.prefilter.context_terms || []).some((k) => kwMatch(text, k)); }
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
function articleText(a) { return (a.title + '. ' + (a.summary || '')).slice(0, 1500); }

/* ---------------- clustering & corroboration ---------------- */
function titleTokens(t) {
  const stop = new Set('the a an of to in on for and or with at by from as is are was were be after over says say said new us u.s. its it that this into amid about than more will'.split(' '));
  return new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !stop.has(w)));
}
function jaccard(a, b) { let i = 0; for (const x of a) if (b.has(x)) i++; const u = a.size + b.size - i; return u ? i / u : 0; }
function clusterArticles(arts, opts) {
  const thr = (opts && opts.threshold) || 0.82;
  const jthr = (opts && opts.title_jaccard) || 0.5;
  const sorted = [...arts].sort((x, y) => y.relevance.score - x.relevance.score);
  const clusters = [];
  for (const a of sorted) {
    const toks = titleTokens(a.title);
    let best = null, bestSim = 0;
    for (const c of clusters) {
      const sim = Math.max(...c.members.map((m) => cosine(a.embedding, m.embedding)));
      const jac = Math.max(...c.members.map((m) => jaccard(toks, m._toks)));
      const s = Math.max(sim, jac >= jthr ? thr : 0);
      if (s >= thr && s > bestSim) { best = c; bestSim = s; }
    }
    a._toks = toks;
    if (best) best.members.push(a); else clusters.push({ members: [a] });
  }
  for (const c of clusters) for (const m of c.members) delete m._toks;
  return clusters;
}
function corroboration(cluster, sourcesById, policy) {
  const groups = new Set(); const outlets = new Set(); let hasPrimary = false;
  for (const m of cluster.members) {
    const s = sourcesById[m.source_id] || {};
    if (s.tier === 'primary') { hasPrimary = true; continue; }
    outlets.add(s.name || m.source_id);
    const counts = s.counts_for_corroboration !== false && !(s.tier === 'research' && policy.corroboration.research_tier_counts === false);
    if (counts) groups.add(s.owner_group || s.id);
  }
  const min = policy.corroboration.min_independent_outlets || 2;
  let category = 'single';
  if (groups.size >= min) category = 'corroborated';
  else if (hasPrimary) category = 'primary';
  return { independent_groups: [...groups], outlets: [...outlets], has_primary: hasPrimary, category };
}
function rankScore(c, nowMs) {
  const rel = Math.max(...c.members.map((m) => m.relevance.score));
  const corro = Math.min(c.corroboration.independent_groups.length + (c.corroboration.has_primary ? 1 : 0), 4) / 4;
  const newest = Math.max(...c.members.map((m) => Date.parse(m.published) || 0));
  const recency = Math.max(0, 1 - (nowMs - newest) / (36 * 3600e3));
  return 0.55 * rel + 0.3 * corro + 0.15 * recency;
}

/* ---------------- robots.txt & article text ---------------- */
function parseRobots(txt, uaToken) {
  const groups = []; let cur = null; let lastWasUA = false;
  for (let line of String(txt || '').split(/\r?\n/)) {
    line = line.replace(/#.*$/, '').trim(); if (!line) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(); const v = line.slice(i + 1).trim();
    if (k === 'user-agent') { if (!cur || !lastWasUA) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasUA = true; continue; }
    lastWasUA = false;
    if (!cur) continue;
    if (k === 'allow' || k === 'disallow') cur.rules.push({ allow: k === 'allow', path: v });
    if (k === 'crawl-delay') cur.crawlDelay = parseFloat(v);
  }
  const ua = String(uaToken || '').toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return { rules: chosen.flatMap((g) => g.rules), crawlDelay: Math.max(0, ...chosen.map((g) => g.crawlDelay || 0)) };
}
function robotsAllows(robots, pathAndQuery) {
  let best = null;
  for (const r of robots.rules) {
    if (r.path === '') { if (!r.allow) continue; }
    const re = new RegExp('^' + r.path.split('*').map(escapeRe).join('.*').replace(/\\\$$/, '$'));
    if (re.test(pathAndQuery)) { if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r; }
  }
  return !best || best.allow;
}
function extractArticleText(html) {
  html = String(html || '');
  let scope = html;
  const art = html.match(/<article[\s\S]*?<\/article>/i);
  if (art && art[0].length > 1500) scope = art[0];
  const paras = [];
  const re = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi; let m;
  while ((m = re.exec(scope))) {
    const t = cleanText(m[1]);
    if (t.length >= 60 && !/^(advertisement|subscribe|sign up|follow us|©|copyright)/i.test(t)) paras.push(t);
  }
  return paras.join('\n').slice(0, 12000);
}

/* ---------------- LLM prompts & validation ---------------- */
function fill(tpl, vars) { return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] == null ? '' : String(vars[k]))); }
function priorityCatalog(topics) {
  return topics.priorities.map((p) => `- ${p.id} [${p.strategy}] ${p.label}: ${p.description}`).join('\n');
}
function classifySchema(topics) {
  const ids26 = topics.priorities.filter((p) => p.strategy !== 'nds2022').map((p) => p.id);
  const ids22 = topics.priorities.filter((p) => p.strategy !== 'nds2026').map((p) => p.id);
  return { type: 'object', properties: {
    relevant: { type: 'boolean' }, score: { type: 'number' },
    nds2026_tags: { type: 'array', items: { type: 'string', enum: ids26 } },
    nds2022_tags: { type: 'array', items: { type: 'string', enum: ids22 } },
    rationale: { type: 'string' } }, required: ['relevant', 'score', 'nds2026_tags', 'nds2022_tags', 'rationale'] };
}
function buildClassifyBody(article, cfg, model, retryNote) {
  const p = cfg.prompts.classify;
  const messages = [
    { role: 'system', content: fill(p.system, { catalog: priorityCatalog(cfg.topics) }) },
    { role: 'user', content: fill(p.user, { source: article.source_name, title: article.title, summary: article.summary || '(no summary)', published: article.published }) },
  ];
  if (retryNote) messages.push({ role: 'user', content: retryNote });
  return { model, messages, stream: false, format: classifySchema(cfg.topics), options: { temperature: 0, num_ctx: 4096 }, keep_alive: '30m' };
}
function parseLlmJson(resp) {
  const content = resp && resp.message && typeof resp.message.content === 'string' ? resp.message.content : (typeof resp === 'string' ? resp : null);
  if (content == null) return { error: 'no message content' };
  const s = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return { value: JSON.parse(s) }; } catch (e) {
    const m = s.match(/\{[\s\S]*\}/); if (m) { try { return { value: JSON.parse(m[0]) }; } catch (e2) { /* fallthrough */ } }
    return { error: 'invalid JSON: ' + e.message };
  }
}
function validateClassification(v, topics) {
  const errs = [];
  if (!v || typeof v !== 'object') return { ok: false, errors: ['not an object'] };
  if (typeof v.relevant !== 'boolean') errs.push('relevant must be boolean');
  if (typeof v.score !== 'number' || !(v.score >= 0 && v.score <= 1)) errs.push('score must be a number 0-1');
  if (!Array.isArray(v.nds2026_tags)) errs.push('nds2026_tags must be an array');
  if (!Array.isArray(v.nds2022_tags)) errs.push('nds2022_tags must be an array');
  if (typeof v.rationale !== 'string') errs.push('rationale must be a string');
  if (errs.length) return { ok: false, errors: errs };
  const ids = new Set(topics.priorities.map((p) => p.id));
  const strat = Object.fromEntries(topics.priorities.map((p) => [p.id, p.strategy]));
  const t26 = [...new Set(v.nds2026_tags)].filter((t) => ids.has(t) && strat[t] !== 'nds2022');
  const t22 = [...new Set(v.nds2022_tags)].filter((t) => ids.has(t) && strat[t] !== 'nds2026');
  let score = v.score;
  if (!v.relevant) score = Math.min(score, 0.3);
  return { ok: true, value: { relevant: v.relevant, score, nds2026_tags: t26, nds2022_tags: t22, rationale: truncate(v.rationale, 400) } };
}
const SUMMARY_SCHEMA = { type: 'object', properties: {
  headline: { type: 'string' }, summary: { type: 'string' },
  discrepancies: { type: 'array', items: { type: 'string' } } }, required: ['headline', 'summary', 'discrepancies'] };
function buildSummaryBody(story, cfg, model, retryNote) {
  const p = cfg.prompts.summarize;
  const docs = story.members.map((m, i) => `[${i + 1}] ${m.source_name} (${m.tier_label}) — "${m.title}"\nPublished: ${m.published}\nText (${m.full_text ? 'full article excerpt' : 'feed excerpt only'}):\n${truncate(m.full_text || m.summary || m.title, story.members.length > 3 ? 2500 : 4000)}`).join('\n\n');
  const messages = [
    { role: 'system', content: p.system },
    { role: 'user', content: fill(p.user, { documents: docs, count: story.members.length }) },
  ];
  if (retryNote) messages.push({ role: 'user', content: retryNote });
  return { model, messages, stream: false, format: SUMMARY_SCHEMA, options: { temperature: 0.1, num_ctx: 8192 }, keep_alive: '30m' };
}
function sentenceCount(s) { return (String(s).trim().match(/[^.!?]+(?:[.!?]+["'’”)]?|$)/g) || []).filter((x) => x.trim().length > 3).length; }
function validateSummary(v, prompts) {
  const errs = [];
  if (!v || typeof v !== 'object') return { ok: false, errors: ['not an object'] };
  if (typeof v.headline !== 'string' || v.headline.trim().length < 8) errs.push('headline missing');
  if (typeof v.summary !== 'string' || v.summary.trim().length < 40) errs.push('summary missing or too short');
  if (!Array.isArray(v.discrepancies)) errs.push('discrepancies must be an array');
  if (errs.length) return { ok: false, errors: errs };
  const n = sentenceCount(v.summary);
  if (n < 2 || n > 5) errs.push(`summary must be 2-4 sentences (got ${n})`);
  const text = (v.headline + ' ' + v.summary + ' ' + v.discrepancies.join(' '));
  const loaded = (prompts.loaded_terms || []).filter((t) => kwMatch(text, t));
  if (loaded.length) errs.push('avoid loaded/evaluative terms: ' + loaded.join(', '));
  const attr = prompts.attribution_markers || [];
  if (attr.length && !attr.some((t) => kwMatch(v.summary, t))) errs.push('attribute claims to their source (e.g., "the Pentagon said", "according to")');
  if (errs.length) return { ok: false, errors: errs, value: v };
  return { ok: true, value: { headline: truncate(v.headline.trim(), 160), summary: v.summary.trim(), discrepancies: v.discrepancies.map((d) => String(d).trim()).filter(Boolean).slice(0, 3) } };
}

/* ---------------- strategy alignment ---------------- */
function tagCounts(members) {
  const c = {};
  for (const m of members) for (const t of [...m.relevance.nds2026_tags, ...m.relevance.nds2022_tags]) c[t] = (c[t] || 0) + 1;
  return c;
}
function alignment(story, topics) {
  const byId = Object.fromEntries(topics.priorities.map((p) => [p.id, p]));
  const counts = tagCounts(story.members);
  const ordered = Object.keys(counts).filter((t) => byId[t]).sort((a, b) => counts[b] - counts[a]);
  const pick = (strategy) => ordered.filter((t) => byId[t].strategy === strategy).slice(0, 3).map((t) => byId[t].short_label);
  const n26 = pick('nds2026'), n22 = pick('nds2022'), xc = pick('cross');
  const parts = [];
  if (n26.length) parts.push('NDS 2026: ' + n26.join(', '));
  if (n22.length) parts.push('NDS 2022: ' + n22.join(', '));
  if (xc.length) parts.push('Also: ' + xc.join(', '));
  const primaryTag = ordered.find((t) => byId[t].strategy !== 'cross') || ordered[0];
  const group = primaryTag ? byId[primaryTag].group : 'Budget, Congress & Leadership';
  const text = story.members.map((m) => m.title + ' ' + (m.summary || '')).join(' ');
  let divergence = null;
  for (const d of topics.divergences || []) {
    if (d.trigger_priorities.some((p) => counts[p]) && d.trigger_keywords.some((k) => kwMatch(text, k))) {
      divergence = { topic: d.topic, nds2026: d.short_2026 || d.nds2026, nds2022: d.short_2022 || d.nds2022 }; break;
    }
  }
  return { line: parts.join(' · '), group, tags: ordered, divergence };
}

/* ---------------- email ---------------- */
const TIER_LABELS = { wire: 'Wire service', trade: 'Defense trade press', general: 'General news', research: 'Nonpartisan research', primary: 'Primary source' };
function fmtDateLA(d, opts) { return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: 'America/Los_Angeles' }, opts)).format(d); }
function subjectFor(now) { return 'Defense Strategy Brief: ' + fmtDateLA(now, { weekday: 'long', month: 'long', day: 'numeric' }); }

function renderEmail(d) {
  const C = { ink: '#1a1f2b', muted: '#5b6472', rule: '#e3e6eb', accent: '#1f4e79', bg: '#f4f5f7', chip: '#eef2f7', warn: '#8a4b00', warnbg: '#fff4e5' };
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
  const h2 = (t) => `<tr><td style="padding:28px 24px 8px;${font}"><h2 style="margin:0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:${C.accent};border-bottom:2px solid ${C.accent};padding-bottom:6px;">${escapeHtml(t)}</h2></td></tr>`;
  const cite = (s) => s.citations.map((c) => `<a href="${escapeHtml(c.url)}" style="color:${C.accent};text-decoration:underline;">${escapeHtml(c.source)}</a> <span style="color:${C.muted};font-size:12px;">(${escapeHtml(c.tier_label)})</span>`).join(' &middot; ');
  const story = (s) => `<tr><td style="padding:14px 24px 4px;${font}">
    <div style="font-size:17px;line-height:1.35;font-weight:600;color:${C.ink};margin:0 0 6px;">${escapeHtml(s.headline)}</div>
    ${s.based_on_excerpt ? `<div style="display:inline-block;font-size:11px;color:${C.warn};background:${C.warnbg};padding:2px 6px;border-radius:3px;margin-bottom:6px;">Based on excerpt</div>` : ''}
    <div style="font-size:15px;line-height:1.55;color:${C.ink};margin:0 0 8px;">${escapeHtml(s.summary)}</div>
    ${s.discrepancies.length ? `<div style="font-size:14px;line-height:1.5;color:${C.ink};margin:0 0 8px;"><strong>Where reports differ:</strong> ${s.discrepancies.map(escapeHtml).join(' ')}</div>` : ''}
    ${s.alignment ? `<div style="font-size:13px;line-height:1.5;color:${C.ink};background:${C.chip};padding:6px 8px;border-radius:4px;margin:0 0 6px;">${escapeHtml(s.alignment)}</div>` : ''}
    ${s.divergence ? `<div style="font-size:13px;line-height:1.5;color:${C.muted};margin:0 0 6px;"><em>Where the strategies differ (${escapeHtml(s.divergence.topic)}):</em> 2026 NDS: ${escapeHtml(s.divergence.nds2026)} 2022 NDS: ${escapeHtml(s.divergence.nds2022)}</div>` : ''}
    <div style="font-size:13px;line-height:1.6;color:${C.ink};margin:0 0 10px;"><strong>Sources:</strong> ${cite(s)}</div>
    <div style="border-bottom:1px solid ${C.rule};"></div></td></tr>`;
  let body = '';
  body += `<tr><td style="padding:24px 24px 4px;${font}"><div style="font-size:22px;font-weight:700;color:${C.ink};">Defense Strategy Brief</div><div style="font-size:14px;color:${C.muted};margin-top:2px;">${escapeHtml(d.dateLine)} &middot; Past 24 hours</div></td></tr>`;
  if (d.alerts && d.alerts.length) body += `<tr><td style="padding:12px 24px 0;${font}"><div style="font-size:13px;color:${C.warn};background:${C.warnbg};padding:8px 10px;border-radius:4px;">${d.alerts.map(escapeHtml).join('<br>')}</div></td></tr>`;
  body += h2('Top line');
  body += `<tr><td style="padding:4px 24px 0;${font}"><ul style="margin:0;padding-left:20px;font-size:15px;line-height:1.55;color:${C.ink};">${d.topLine.map((t) => `<li style="margin:0 0 6px;">${escapeHtml(t)}</li>`).join('')}</ul></td></tr>`;
  for (const g of d.groups) { body += h2(g.name); body += g.stories.map(story).join(''); }
  if (d.primary.length) { body += h2('Primary source updates'); body += `<tr><td style="padding:2px 24px 0;${font}"><div style="font-size:12px;color:${C.muted};">Official government releases and reports. Authoritative for what the government said or did, not neutral analysis.</div></td></tr>` + d.primary.map(story).join(''); }
  if (d.single.length) { body += h2('Single-source reports'); body += `<tr><td style="padding:2px 24px 0;${font}"><div style="font-size:12px;color:${C.muted};">Reported by only one allowlisted outlet; not independently corroborated.</div></td></tr>` + d.single.map(story).join(''); }
  const f = d.footer;
  body += `<tr><td style="padding:28px 24px 28px;${font}"><div style="border-top:1px solid ${C.rule};padding-top:12px;font-size:12px;line-height:1.6;color:${C.muted};">
    Articles scanned: ${f.articlesScanned} &middot; Sources: ${f.feedsOk} of ${f.feedsTotal} feeds OK (${f.outletsContributing} outlets contributed stories)<br>
    Source mix: ${escapeHtml(f.sourceMix)}<br>
    ${f.balanceFlag ? `<span style="color:${C.warn};font-weight:600;">Balance note: ${escapeHtml(f.balanceFlag)}</span><br>` : 'Balance: no single outlet supplied more than half of the stories.<br>'}
    ${f.failedFeeds.length ? `Feeds unavailable this run: ${escapeHtml(f.failedFeeds.join(', '))}<br>` : ''}
    Model: ${escapeHtml(f.model)} (summaries generated locally) &middot; Generated ${escapeHtml(f.generatedAt)}<br>
    Sourcing policy: ${escapeHtml(f.policy)}</div></td></tr>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(d.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:12px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:6px;">${body}</table></td></tr></table></body></html>`;

  const tl = [];
  const tstory = (s) => {
    tl.push('* ' + s.headline + (s.based_on_excerpt ? ' [based on excerpt]' : ''));
    tl.push('  ' + s.summary);
    if (s.discrepancies.length) tl.push('  Where reports differ: ' + s.discrepancies.join(' '));
    if (s.alignment) tl.push('  ' + s.alignment);
    if (s.divergence) tl.push(`  Where the strategies differ (${s.divergence.topic}): 2026 NDS: ${s.divergence.nds2026} 2022 NDS: ${s.divergence.nds2022}`);
    tl.push('  Sources: ' + s.citations.map((c) => `${c.source} (${c.tier_label}) <${c.url}>`).join('; '));
    tl.push('');
  };
  tl.push('DEFENSE STRATEGY BRIEF', d.dateLine + ' · Past 24 hours', '');
  if (d.alerts && d.alerts.length) tl.push(...d.alerts, '');
  tl.push('TOP LINE'); d.topLine.forEach((t) => tl.push('- ' + t)); tl.push('');
  for (const g of d.groups) { tl.push(g.name.toUpperCase()); g.stories.forEach(tstory); }
  if (d.primary.length) { tl.push('PRIMARY SOURCE UPDATES (official releases; authoritative for what the government said or did, not neutral analysis)'); d.primary.forEach(tstory); }
  if (d.single.length) { tl.push('SINGLE-SOURCE REPORTS (not independently corroborated)'); d.single.forEach(tstory); }
  tl.push('---', `Articles scanned: ${f.articlesScanned} · Sources: ${f.feedsOk} of ${f.feedsTotal} feeds OK (${f.outletsContributing} outlets contributed stories)`, 'Source mix: ' + f.sourceMix,
    f.balanceFlag ? 'Balance note: ' + f.balanceFlag : 'Balance: no single outlet supplied more than half of the stories.');
  if (f.failedFeeds.length) tl.push('Feeds unavailable this run: ' + f.failedFeeds.join(', '));
  tl.push(`Model: ${f.model} · Generated ${f.generatedAt}`, 'Sourcing policy: ' + f.policy);
  return { html, text: tl.join('\n') };
}

function b64url(s) {
  const b = typeof Buffer !== 'undefined' ? Buffer.from(s, 'utf8').toString('base64') : btoa(unescape(encodeURIComponent(s)));
  return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function encodeHeader(s) { return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='; }
function wrap76(b64) { return b64.replace(/.{1,76}/g, '$&\r\n'); }
function buildMime({ to, from, subject, html, text }) {
  const boundary = 'dsb_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const lines = [
    from ? 'From: ' + from : null, 'To: ' + to, 'Subject: ' + encodeHeader(subject), 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    '--' + boundary, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(text, 'utf8').toString('base64')),
    '--' + boundary, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(html, 'utf8').toString('base64')),
    '--' + boundary + '--', '',
  ].filter((l) => l !== null);
  return b64url(lines.join('\r\n'));
}

function sourceMix(stories) {
  const counts = {};
  for (const s of stories) for (const o of new Set(s.citations.map((c) => c.source))) counts[o] = (counts[o] || 0) + 1;
  const total = stories.length;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  return {
    counts, total,
    text: entries.map(([k, v]) => `${k} ${v}`).join(', ') || 'none',
    flag: top && total > 0 && top[1] / total > 0.5 ? `${top[0]} appears in ${top[1]} of ${total} stories (${Math.round((100 * top[1]) / total)}%), more than half of this digest.` : null,
  };
}

if (typeof module !== 'undefined') {
  module.exports = { loadConfig, decodeEntities, cleanText, escapeHtml, truncate, parseFeed, looksLikeFeed, parseHtmlList, parseCrsApi, normalizeUrl, exclusionReason,
    inWindow, keywordHits, hasContext, kwMatch, cosine, articleText, clusterArticles, corroboration, rankScore, parseRobots, robotsAllows, extractArticleText,
    buildClassifyBody, parseLlmJson, validateClassification, buildSummaryBody, validateSummary, sentenceCount, alignment, renderEmail, buildMime, subjectFor,
    fmtDateLA, sourceMix, TIER_LABELS, classifySchema };
}
