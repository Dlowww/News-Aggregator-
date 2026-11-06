#!/usr/bin/env node
/* Mock server for the end-to-end test: serves synthetic feeds (timestamped "now"),
 * article pages, robots.txt, and an Ollama-compatible /api/embed and /api/chat.
 * Deliberately returns malformed LLM output once for some items to exercise retries.
 */
'use strict';
const http = require('http');
const PORT = Number(process.env.MOCK_PORT || 11999);
const BASE = `http://127.0.0.1:${PORT}`;
const H = 3600e3;
const ago = (h) => new Date(Date.now() - h * H).toUTCString();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const item = (title, slug, h, desc, cat) => `<item><title>${esc(title)}</title><link>${BASE}/articles/${slug}?utm_source=rss&amp;utm_medium=feed</link><pubDate>${ago(h)}</pubDate><description><![CDATA[${desc}]]></description>${cat ? `<category>${cat}</category>` : ''}</item>`;
const rss = (title, items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${items.join('')}</channel></rss>`;

const FEEDS = {
  defensenews: rss('Defense News', [
    item('Pentagon awards Golden Dome interceptor contract to Lockheed Martin', 'dn-golden-dome', 3, 'The Department of War awarded Lockheed Martin a $2.1 billion contract for Golden Dome space-based interceptors, the Pentagon said.', 'Space'),
    item('Army recruiting tops annual goal early, Pentagon says', 'dn-recruiting', 5, 'The Army met its fiscal 2027 recruiting goal, Army officials said, citing new incentives.', 'Pentagon'),
    item('Opinion: The Golden Dome needs a rethink', 'opinion/dn-golden-dome-oped', 2, 'An op-ed arguing for changes to missile defense.', 'Opinion'),
    item('Navy commissions new destroyer', 'dn-destroyer-old', 80, 'An older story outside the window.', 'Naval'),
  ]),
  breakingdefense: rss('Breaking Defense', [
    item('Lockheed wins Golden Dome interceptor deal from Pentagon', 'bd-golden-dome', 2, 'Lockheed Martin won a contract valued at about $2 billion for Golden Dome interceptors, according to a Department of War announcement.', 'Missile Defense'),
    item('House Armed Services panel advances NDAA amendment on shipbuilding', 'bd-ndaa-shipbuilding', 6, 'The House Armed Services Committee advanced an NDAA amendment requiring a shipbuilding industrial base report, committee aides said.', 'Congress'),
  ]),
  militarytimes: rss('Military Times', [
    item('Army recruiting surpasses annual goal ahead of schedule', 'mt-recruiting', 4, 'The Army surpassed its fiscal 2027 recruiting goal, officials said Tuesday.', 'Army'),
    item('PLA drills near Taiwan draw INDOPACOM statement', 'mt-pla-taiwan', 7, 'U.S. Indo-Pacific Command said it was monitoring People\'s Liberation Army drills near Taiwan, according to a command statement.', 'Indo-Pacific'),
  ]),
  bbc: rss('BBC News - US & Canada', [
    item('Chinese military drills near Taiwan draw INDOPACOM statement', 'bbc-pla-taiwan', 6, 'The US military said it was closely watching Chinese drills around Taiwan, the BBC reported.', ''),
    item('Football club wins national cup final', 'bbc-football', 3, 'A sports story with no defense angle.', ''),
  ]),
  war_releases: rss('News Releases - U.S. Dept. of War', [
    item('Department of War awards Golden Dome interceptor contract to Lockheed Martin', 'war-golden-dome', 3, 'The Department of War announced an award to Lockheed Martin for Golden Dome space-based interceptors.', ''),
    item('Readout of U.S.-China Crisis Communications Working Group', 'war-china-readout', 8, 'The U.S. and China agreed on the importance of practical communication measures to reduce risks, the Department of War said.', ''),
  ]),
};
const CSIS = `<html><body>
<article class="article-search-listing flex"><div><h3 class="headline-sm"><a href="${BASE}/articles/csis-golden-dome-report" class="hocus-headline"><span>Golden Dome Interceptors: Cost and Schedule Questions</span></a></h3>
<div class="search-listing--summary mb-lg teaser"><p>A report on the Golden Dome space-based interceptor program.</p></div>
<div class="contributors credit text-low-contrast"><p> Report by <span>Analyst</span> <span class="inline-block">— ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span></p></div></div></article>
<article class="article-search-listing flex"><div><h3 class="headline-sm"><a href="${BASE}/articles/csis-oped" class="hocus-headline"><span>Why Golden Dome Is the Wrong Priority</span></a></h3>
<div class="search-listing--summary mb-lg teaser"><p>Commentary.</p></div>
<div class="contributors credit text-low-contrast"><p> Commentary by <span>Scholar</span> <span class="inline-block">— ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span></p></div></div></article>
</body></html>`;
const ROBOTS = 'User-agent: *\nDisallow: /articles/bd-\n';
const articlePage = (slug) => `<html><body><article><h1>${slug}</h1>` + Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i + 1} of the full article ${slug}. The Department of War said officials confirmed the details in a statement on Tuesday, and the figures were reported as stated.</p>`).join('') + '</article></body></html>';

// ---- deterministic "embeddings": hashed bag of words over the title ----
const STOP = new Set('the a an of to in on for and or with at by from as is are new says said us u.s.'.split(' '));
function embed(text) {
  const v = new Array(256).fill(0);
  const t = text.replace(/^clustering:\s*/, '');
  const title = t.split('. ')[0];
  for (const w of title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) {
    if (!w || STOP.has(w)) continue;
    let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 256] += 1;
  }
  return v;
}

// ---- mock LLM ----
const calls = { classify: {}, summarize: {} };
function classify(body) {
  const user = body.messages.find((m) => m.role === 'user').content;
  const title = (user.match(/Title: (.*)/) || [])[1] || '';
  const isRetry = body.messages.length > 2;
  calls.classify[title] = (calls.classify[title] || 0) + 1;
  if (/^PLA drills/.test(title) && !isRetry) return 'Sure! Here is my answer: relevant=yes';
  const T = (re, a, b) => (re.test(title) ? [a, b] : null);
  const rules = [T(/Golden Dome|interceptor/i, 'nds26_homeland', 'nds22_nuclear_missile_defense'), T(/Taiwan|PLA|China/i, 'nds26_china', 'nds22_pacing_challenge'),
    T(/NDAA/i, 'x_budget', 'x_budget'), T(/recruiting/i, 'x_leadership', 'nds22_joint_force')].filter(Boolean);
  if (!rules.length) return JSON.stringify({ relevant: false, score: 0.05, nds2026_tags: [], nds2022_tags: [], rationale: 'No defense link.' });
  return JSON.stringify({ relevant: true, score: /Golden Dome|Taiwan|PLA/.test(title) ? 0.9 : 0.75, nds2026_tags: [rules[0][0]], nds2022_tags: [rules[0][1]], rationale: 'Mock rationale.' });
}
function summarize(body) {
  const user = body.messages.find((m) => m.role === 'user').content;
  const docs = [...user.matchAll(/\[\d+\] (.+?) \((.+?)\) — "(.+?)"/g)].map((m) => ({ src: m[1], title: m[3] }));
  const key = docs.map((d) => d.title).join('|');
  const isRetry = body.messages.length > 2;
  calls.summarize[key] = (calls.summarize[key] || 0) + 1;
  const d0 = docs[0] || { src: 'The source', title: 'An event occurred' };
  if (/Golden Dome/.test(key) && !isRetry) return JSON.stringify({ headline: 'Historic Golden Dome award', summary: 'In a historic move the Pentagon said it awarded a contract. It is a landmark deal.', discrepancies: [] });
  const second = docs[1] ? `${docs[1].src} also reported the development.` : 'Officials said further details would follow.';
  const disc = /Golden Dome/.test(key) ? ['Defense News put the contract at $2.1 billion; Breaking Defense reported about $2 billion.'] : [];
  return JSON.stringify({ headline: d0.title, summary: `${d0.src} reported that ${d0.title.charAt(0).toLowerCase() + d0.title.slice(1)}. ${second}`, discrepancies: disc });
}

const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const u = new URL(req.url, BASE);
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
    if (u.pathname === '/robots.txt') return send(200, 'text/plain', ROBOTS);
    if (u.pathname.startsWith('/feeds/')) {
      const id = u.pathname.slice(7).replace(/\.xml$/, '');
      if (id === 'csis') return send(200, 'text/html', CSIS);
      if (id === 'dead') return send(500, 'text/plain', 'upstream error');
      if (FEEDS[id]) return send(200, 'application/rss+xml', FEEDS[id]);
      return send(404, 'text/plain', 'no such feed');
    }
    if (u.pathname.startsWith('/articles/')) return send(200, 'text/html', articlePage(u.pathname.slice(10)));
    if (u.pathname === '/api/embed') { const b = JSON.parse(data); return send(200, 'application/json', JSON.stringify({ model: b.model, embeddings: b.input.map(embed) })); }
    if (u.pathname === '/api/chat') {
      const b = JSON.parse(data);
      const isClassify = b.format && b.format.properties && b.format.properties.relevant;
      const content = isClassify ? classify(b) : summarize(b);
      return send(200, 'application/json', JSON.stringify({ model: b.model, message: { role: 'assistant', content }, done: true }));
    }
    if (u.pathname === '/__calls') return send(200, 'application/json', JSON.stringify(calls));
    send(404, 'text/plain', 'not found');
  });
});
server.listen(PORT, '127.0.0.1', () => console.log('mock server on ' + BASE));
