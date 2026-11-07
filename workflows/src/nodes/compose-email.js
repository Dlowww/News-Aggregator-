// Builds the digest (HTML + plain text), the balance check and run stats.
const cfg = loadConfig($env.DSB_CONFIG_DIR || '/data/config');
const items = $input.all().map((i) => i.json);
const stats = Object.assign({}, $('Select stories & fetch article text').first().json.stats);
const ok = items.filter((x) => x.story && x.story.written);
stats.summary_failures = items.filter((x) => x.failed).length;
stats.summary_retries = items.filter((x) => x.retried).length + stats.summary_failures;
const now = new Date();
const toStory = (s) => {
  // Citations come from the cluster's articles, never from the model, so every summary is linked to its sources.
  const seen = new Set();
  const citations = [];
  for (const m of [...s.members, ...s.all_members]) {
    if (seen.has(m.url_norm)) continue; seen.add(m.url_norm);
    citations.push({ source: m.source_name, tier_label: m.tier_label, url: m.link, source_id: m.source_id, url_norm: m.url_norm, title: m.title });
  }
  return { id: s.id, section: s.section, rank: s.rank, headline: s.written.headline, summary: s.written.summary, discrepancies: s.written.discrepancies,
    alignment: s.alignment.line, divergence: s.alignment.divergence, group: s.alignment.group, based_on_excerpt: s.based_on_excerpt, citations: citations.slice(0, 8) };
};
const stories = ok.map((x) => toStory(x.story)).filter((s) => s.citations.length > 0).sort((a, b) => b.rank - a.rank);
const main = stories.filter((s) => s.section === 'main');
const primary = stories.filter((s) => s.section === 'primary');
const single = stories.filter((s) => s.section === 'single');
const groups = cfg.topics.email_groups_order.map((name) => ({ name, stories: main.filter((s) => s.group === name) })).filter((g) => g.stories.length);
const other = main.filter((s) => !cfg.topics.email_groups_order.includes(s.group));
if (other.length) groups.push({ name: 'Other defense news', stories: other });
// Top line: corroborated and primary stories first; single-source headlines are labeled if used to fill.
const topLine = [...main, ...primary].slice(0, 5).map((s) => s.headline);
for (const s of single) { if (topLine.length >= 3) break; topLine.push(s.headline + ' (single source)'); }
// Show each "where the strategies differ" note once per digest, on the highest-ranked story it applies to.
const shownDiv = new Set();
for (const s of [...main, ...primary, ...single]) { if (!s.divergence) continue; if (shownDiv.has(s.divergence.topic)) s.divergence = null; else shownDiv.add(s.divergence.topic); }
const mix = sourceMix(stories);
const failRatio = stats.feeds_total ? stats.feeds_failed / stats.feeds_total : 0;
const alerts = [];
if (failRatio > 0.3) alerts.push(`Warning: ${stats.feeds_failed} of ${stats.feeds_total} feeds failed this run (${Math.round(failRatio * 100)}%). Coverage may be incomplete.`);
if (stats.skipped_feeds && stats.skipped_feeds.length) alerts.push('Skipped: ' + stats.skipped_feeds.join('; '));
const exceptions = cfg.sources.sources.filter((s) => s.status === 'approved' && s.approval_basis === 'user_override').length;
const policy = 'Only allowlisted sources are used: outlets rated center/least-biased with high factual reliability by at least two of AllSides, Ad Fontes Media and Media Bias/Fact Check'
  + (exceptions ? `, plus ${exceptions} owner-approved exceptions,` : '') + ' and official primary sources. Main stories are reported by at least two independent outlets or a primary source; others appear under Single-source reports. Opinion and sponsored content are excluded.';
const subject = subjectFor(now);
const d = { subject, dateLine: fmtDateLA(now, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), alerts, topLine, groups, primary, single,
  footer: { articlesScanned: stats.in_window, feedsOk: stats.feeds_ok, feedsTotal: stats.feeds_total, outletsContributing: Object.keys(mix.counts).length, sourceMix: mix.text,
    balanceFlag: mix.flag, failedFeeds: (stats.failed_feeds || []).map((f) => f.source), model: $env.OLLAMA_MODEL,
    generatedAt: fmtDateLA(now, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }), policy } };
stats.stories_sent = stories.length;
stats.stories_main = main.length; stats.stories_primary = primary.length; stats.stories_single = single.length;
stats.source_mix = mix.counts; stats.balance_flag = mix.flag;
stats.model = $env.OLLAMA_MODEL; stats.embed_model = $env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
stats.finished_at = now.toISOString();
stats.duration_sec = Math.round((now - Date.parse(stats.started_at)) / 1000);
if (!stories.length) return [{ json: { no_stories: true, stats, run_id: stats.run_id } }];
const { html, text } = renderEmail(d);
const to = $env.DIGEST_RECIPIENT;
if (!to) throw new Error('DIGEST_RECIPIENT is not set in .env');
const sent_rows = stories.flatMap((s) => s.citations.map((c) => ({ u: c.url_norm, url: c.url, t: c.title, s: c.source_id })));
const dry = String($env.DSB_DRY_RUN || '').toLowerCase() === 'true';
return [{ json: { run_id: stats.run_id, status: dry ? 'dry_run' : 'sent', to, subject, html, text, stats, sent_rows, dry_run: dry } }];
