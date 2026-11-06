#!/usr/bin/env node
/* Unit tests for workflows/src/lib.js. Run: node tests/run-tests.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../workflows/src/lib.js');
const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const cfg = L.loadConfig(path.join(__dirname, '..', 'config'));
let passed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log('ok   ' + name); } catch (e) { console.error('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; } };

t('config: every approved source has a feed and valid tier', () => {
  const tiers = new Set(['wire', 'trade', 'general', 'research', 'primary']);
  const ap = cfg.sources.sources.filter((s) => s.status === 'approved');
  assert.ok(ap.length >= 20);
  for (const s of ap) { assert.ok(tiers.has(s.tier), s.id); assert.ok(s.feeds.length > 0, s.id + ' has no feed'); assert.ok(s.owner_group, s.id); }
});
t('config: priority ids unique; divergence triggers reference real ids', () => {
  const ids = cfg.topics.priorities.map((p) => p.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const d of cfg.topics.divergences) for (const p of d.trigger_priorities) assert.ok(ids.includes(p), d.id + ':' + p);
  for (const p of cfg.topics.priorities) assert.ok(cfg.topics.email_groups_order.includes(p.group), p.id + ' group ' + p.group);
});
t('parseFeed: Defense News RSS', () => {
  const items = L.parseFeed(fx('defensenews.xml'));
  assert.strictEqual(items.length, 10);
  for (const i of items) { assert.ok(/^https:\/\/www\.defensenews\.com\//.test(i.link), i.link); assert.ok(i.published); assert.ok(i.title.length > 5); }
  assert.ok(items[0].content_text.length > 200, 'content:encoded extracted');
});
t('parseFeed: Atom entries', () => {
  const xml = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title><entry><title>A &amp; B</title><link rel="alternate" href="https://ex.com/a?utm_source=x"/><updated>2026-11-05T10:00:00Z</updated><summary>S</summary></entry></feed>';
  const items = L.parseFeed(xml);
  assert.strictEqual(items.length, 1); assert.strictEqual(items[0].title, 'A & B'); assert.strictEqual(items[0].published, '2026-11-05T10:00:00.000Z');
});
t('parseHtmlList: HASC', () => {
  const items = L.parseHtmlList(fx('hasc.html'), 'hasc', 'https://armedservices.house.gov/news/documentquery.aspx?DocumentTypeID=27');
  assert.ok(items.length >= 5, 'got ' + items.length);
  assert.strictEqual(items[0].title, 'Chairman Rogers Applauds House Passage of FY27 NDAA');
  assert.ok(items[0].link.includes('DocumentID=6737'));
  assert.ok(items[0].published.startsWith('2026-07-22'));
  assert.ok(!/Read more/.test(items[0].summary));
});
t('parseHtmlList: SASC', () => {
  const items = L.parseHtmlList(fx('sasc.html'), 'sasc', 'https://www.armed-services.senate.gov/press-releases');
  assert.ok(items.length >= 5, 'got ' + items.length);
  assert.ok(items[0].title.startsWith('SASC Chairman Roger Wicker'));
  assert.ok(items[0].published.startsWith('2026-06-16'));
});
t('parseHtmlList: CSIS with type labels', () => {
  const items = L.parseHtmlList(fx('csis.html'), 'csis', 'https://www.csis.org/analysis');
  assert.ok(items.length >= 5, 'got ' + items.length);
  const first = items[0];
  assert.strictEqual(first.title, 'National Security Cannot Be an Afterthought in Antitrust Enforcement');
  assert.strictEqual(first.type_label, 'Commentary');
  assert.ok(first.published.startsWith('2026-11-05'));
  assert.ok(/Commentary/.test(L.exclusionReason(first, cfg.sources.policy)));
  assert.ok(items.some((i) => i.type_label === 'Critical Questions' && !L.exclusionReason(i, cfg.sources.policy)));
});
t('parseCrsApi: tolerant parsing', () => {
  const items = L.parseCrsApi({ CRSReports: [{ id: 'R48000', title: 'Navy Ship Names', publishDate: '2026-11-05T00:00:00Z', url: 'https://api.congress.gov/v3/crsreport/R48000' }] });
  assert.strictEqual(items.length, 1); assert.strictEqual(items[0].link, 'https://www.congress.gov/crs-product/R48000');
});
t('normalizeUrl strips tracking params and trailing slash', () => {
  assert.strictEqual(L.normalizeUrl('http://WWW.Example.com:80/a/b/?utm_source=x&id=3&fbclid=9#frag'), 'https://www.example.com/a/b?id=3');
  assert.strictEqual(L.normalizeUrl('https://www.bbc.co.uk/news/articles/x?at_medium=RSS&at_campaign=rss'), 'https://www.bbc.co.uk/news/articles/x');
  assert.strictEqual(L.normalizeUrl('https://apnews.com/article/x?utm_source=flipboard&utm_content=AssociatedPress%2Fmagazine'), 'https://apnews.com/article/x');
  assert.strictEqual(L.normalizeUrl('https://armedservices.house.gov/news/documentsingle.aspx?DocumentID=6737'), 'https://armedservices.house.gov/news/documentsingle.aspx?DocumentID=6737');
});
t('exclusions: opinion URL and category', () => {
  const pol = cfg.sources.policy;
  assert.ok(L.exclusionReason({ link: 'https://www.defensenews.com/opinion/2026/11/05/x/', categories: [] }, pol));
  assert.ok(L.exclusionReason({ link: 'https://x.com/a', categories: ['Commentary'] }, pol));
  assert.strictEqual(L.exclusionReason({ link: 'https://x.com/news/a', categories: ['Pentagon'] }, pol), null);
});
t('inWindow: 24h and day-precision slack', () => {
  const now = Date.parse('2026-11-06T13:00:00Z');
  assert.ok(L.inWindow({ published: '2026-11-05T14:00:00Z' }, now, 24));
  assert.ok(!L.inWindow({ published: '2026-11-05T12:00:00Z' }, now, 24));
  assert.ok(L.inWindow({ published: '2026-11-05T17:00:00Z', date_precision: 'day' }, now, 24));
  assert.ok(!L.inWindow({ published: null }, now, 24));
  assert.ok(L.inWindow({ published: '2026-11-06T17:00:00Z', date_precision: 'day' }, Date.parse('2026-11-06T05:00:00Z'), 24), 'today-noon list item early in the day');
  assert.ok(!L.inWindow({ published: '2026-11-06T17:00:00Z' }, Date.parse('2026-11-06T05:00:00Z'), 24), 'timestamped future item');
});
t('keyword matching: acronyms case-sensitive, Department of War aliases', () => {
  const hits = L.keywordHits('Pentagon awards contract for Golden Dome interceptors; PLA drills near Taiwan', cfg.topics);
  assert.ok(hits.nds26_homeland && hits.nds26_homeland.includes('Golden Dome'));
  assert.ok(hits.nds26_china && hits.nds26_china.includes('PLA'));
  assert.ok(!L.kwMatch('people said the plan was fine', 'PLA'));
  assert.ok(L.hasContext('The Department of War said Tuesday', cfg.topics));
  assert.ok(L.hasContext('The Department of Defense said Tuesday', cfg.topics));
});
t('clustering + corroboration (same owner counts once; research excluded)', () => {
  const v = (x) => { const a = new Array(8).fill(0); a[x] = 1; return a; };
  const mk = (id, src, title, emb, score) => ({ id, source_id: src, title, embedding: emb, published: '2026-11-06T01:00:00Z', relevance: { score, nds2026_tags: ['nds26_china'], nds2022_tags: ['nds22_pacing_challenge'] } });
  const arts = [
    mk(1, 'defensenews', 'Navy deploys carrier to Taiwan Strait', v(0), 0.9),
    mk(2, 'militarytimes', 'Carrier deploys to Taiwan Strait, Navy says', v(0), 0.8),
    mk(3, 'csis', 'What a carrier deployment to the Taiwan Strait means', v(0), 0.7),
    mk(4, 'usni', 'Unrelated GAO report on depots', v(3), 0.7),
  ];
  const cl = L.clusterArticles(arts, { threshold: 0.82 });
  assert.strictEqual(cl.length, 2);
  const byId = Object.fromEntries(cfg.sources.sources.map((s) => [s.id, s]));
  const c0 = cl.find((c) => c.members.length === 3);
  const co = L.corroboration(c0, byId, cfg.sources.policy);
  assert.strictEqual(co.independent_groups.length, 1, 'Defense News + Military Times share Sightline; CSIS is research');
  assert.strictEqual(co.category, 'single');
  arts.push(mk(5, 'breakingdefense', 'Navy sends carrier to Taiwan Strait', v(0), 0.85));
  const cl2 = L.clusterArticles(arts, { threshold: 0.82 });
  const co2 = L.corroboration(cl2.find((c) => c.members.length === 4), byId, cfg.sources.policy);
  assert.strictEqual(co2.category, 'corroborated');
});
t('robots.txt parsing', () => {
  const r = L.parseRobots('User-agent: *\nDisallow: /news/documentprint.aspx*\nDisallow: /*?\nAllow: /*?page=\n\nUser-agent: Bytespider\nDisallow: /', 'DefenseStrategyBrief/1.0');
  assert.ok(L.robotsAllows(r, '/news/documentsingle'));
  assert.ok(!L.robotsAllows(r, '/news/documentprint.aspx?x=1'));
  assert.ok(!L.robotsAllows(r, '/analysis?x=1'));
  assert.ok(L.robotsAllows(r, '/analysis?page=2'));
  const all = L.parseRobots('User-agent: *\nDisallow: /', 'x');
  assert.ok(!L.robotsAllows(all, '/anything'));
  assert.ok(L.robotsAllows(L.parseRobots('', 'x'), '/a'));
});
t('extractArticleText from RSS content', () => {
  const items = L.parseFeed(fx('defensenews.xml'));
  const txt = L.extractArticleText('<html><body><article>' + '<p>' + 'x'.repeat(10) + '</p>' + items[0].content_text.split('. ').map((s) => '<p>' + s + ' and more words to pass the length filter here.</p>').join('') + '</article></body></html>');
  assert.ok(txt.length > 200);
});
t('classification validation', () => {
  const ok = L.validateClassification({ relevant: true, score: 0.8, nds2026_tags: ['nds26_china', 'bogus', 'nds22_homeland'], nds2022_tags: ['nds22_pacing_challenge', 'x_budget'], rationale: 'r' }, cfg.topics);
  assert.ok(ok.ok); assert.deepStrictEqual(ok.value.nds2026_tags, ['nds26_china']); assert.deepStrictEqual(ok.value.nds2022_tags, ['nds22_pacing_challenge', 'x_budget']);
  assert.ok(!L.validateClassification({ relevant: 'yes', score: 2 }, cfg.topics).ok);
  assert.strictEqual(L.parseLlmJson({ message: { content: '```json\n{"a":1}\n```' } }).value.a, 1);
  assert.ok(L.parseLlmJson({ message: { content: 'not json' } }).error);
});
t('summary validation: sentences, loaded terms, attribution', () => {
  const good = { headline: 'Navy deploys carrier to the Taiwan Strait', summary: 'The Navy said Tuesday it deployed a carrier to the Taiwan Strait. Defense News reported the deployment will last two weeks.', discrepancies: [] };
  assert.ok(L.validateSummary(good, cfg.prompts).ok);
  const loaded = Object.assign({}, good, { summary: 'The Navy said it made a historic deployment. Officials said it was a landmark move.' });
  const r = L.validateSummary(loaded, cfg.prompts); assert.ok(!r.ok); assert.ok(/historic/.test(r.errors.join()));
  const noattr = Object.assign({}, good, { summary: 'A carrier went to the Taiwan Strait. It will stay two weeks.' });
  assert.ok(!L.validateSummary(noattr, cfg.prompts).ok);
  const one = Object.assign({}, good, { summary: 'The Navy said it deployed a carrier to the Taiwan Strait on Tuesday for two weeks.' });
  assert.ok(!L.validateSummary(one, cfg.prompts).ok);
});
t('alignment line & divergence', () => {
  const story = { members: [{ title: 'NATO allies boost spending as Russia threat persists', summary: '', relevance: { nds2026_tags: ['nds26_burden'], nds2022_tags: ['nds22_russia_acute', 'x_budget'] } }] };
  const a = L.alignment(story, cfg.topics);
  assert.strictEqual(a.line, 'NDS 2026: Allied burden-sharing · NDS 2022: Acute threat (Russia) · Also: Budget & NDAA');
  assert.strictEqual(a.divergence.topic, 'Russia and European defense');
  assert.strictEqual(a.group, 'Allies, Partners & Regional Security');
});
t('email render + MIME', () => {
  const s = { headline: 'H <1>', summary: 'The Navy said X. Defense News reported Y.', discrepancies: [], alignment: 'NDS 2026: Deter China (Indo-Pacific)', divergence: null, based_on_excerpt: true,
    citations: [{ source: 'Defense News', tier_label: 'Defense trade press', url: 'https://www.defensenews.com/a?x=1&y=2' }] };
  const d = { subject: L.subjectFor(new Date('2026-11-06T13:00:00Z')), dateLine: 'Friday, November 6, 2026', alerts: [], topLine: ['H <1>'], groups: [{ name: 'China & the Indo-Pacific', stories: [s] }], primary: [], single: [s],
    footer: { articlesScanned: 100, feedsOk: 30, feedsTotal: 31, outletsContributing: 5, sourceMix: 'Defense News 2', balanceFlag: 'Defense News appears in 2 of 2 stories', failedFeeds: ['X'], model: 'qwen2.5:14b', generatedAt: 'now', policy: 'p' } };
  assert.strictEqual(d.subject, 'Defense Strategy Brief: Friday, November 6');
  const e = L.renderEmail(d);
  assert.ok(e.html.includes('H &lt;1&gt;')); assert.ok(e.html.includes('Based on excerpt')); assert.ok(e.html.includes('Single-source reports'));
  assert.ok(e.html.includes('href="https://www.defensenews.com/a?x=1&amp;y=2"'));
  assert.ok(e.text.includes('Sources: Defense News (Defense trade press) <https://www.defensenews.com/a?x=1&y=2>'));
  const raw = L.buildMime({ to: 'a@b.c', subject: d.subject + ' — ü', html: e.html, text: e.text });
  const dec = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.ok(/multipart\/alternative/.test(dec)); assert.ok(/Subject: =\?UTF-8\?B\?/.test(dec)); assert.ok(dec.includes('text/plain') && dec.includes('text/html'));
});
t('balance flag > 50%', () => {
  const st = (src) => ({ citations: [{ source: src }] });
  assert.ok(L.sourceMix([st('A'), st('A'), st('B')]).flag);
  assert.strictEqual(L.sourceMix([st('A'), st('B')]).flag, null);
});
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
