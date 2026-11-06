// Called by the daily workflow: no qualifying stories, or too many feed failures.
const j = $input.first().json;
const st = j.stats || {};
const failed = (st.failed_feeds || []).map((f) => `  - ${f.source}: ${f.error}`);
let subject, intro;
if (j.alert_type === 'no_stories') { subject = '[ALERT] Defense Strategy Brief: no qualifying stories today'; intro = 'The daily run finished but found no stories that passed the relevance, de-duplication and corroboration rules, so no digest was sent.'; }
else { subject = `[ALERT] Defense Strategy Brief: ${st.feeds_failed} of ${st.feeds_total} feeds failed`; intro = `More than ${Math.round(100 * Number($env.FEED_FAILURE_ALERT_RATIO || 0.3))}% of feeds failed this run. The digest was still sent, with reduced coverage.`; }
const lines = [intro, '', 'Run: ' + (st.run_id || j.run_id || 'unknown'),
  `Feeds OK/failed: ${st.feeds_ok ?? '?'} / ${st.feeds_failed ?? '?'} · Articles fetched: ${st.articles_fetched ?? '?'} · In 24h window: ${st.in_window ?? '?'}`,
  `Passed prefilter: ${st.prefilter_pass ?? '?'} · Passed relevance: ${st.relevance_pass ?? '?'} · Clusters: ${st.clusters ?? '?'} · Stories sent: ${st.stories_sent ?? 0}`,
  failed.length ? 'Failed feeds:\n' + failed.join('\n') : 'Failed feeds: none',
  (st.skipped_feeds || []).length ? 'Skipped: ' + st.skipped_feeds.join('; ') : null,
  '', 'If feeds keep failing, a publisher may have moved or dropped its feed. Test URLs with scripts/test-feeds.sh and update config/sources.json.'].filter((l) => l !== null);
return [{ json: { subject, text: lines.join('\n'), html: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1f2b;white-space:pre-wrap">' + escapeHtml(lines.join('\n')) + '</div>' } }];
