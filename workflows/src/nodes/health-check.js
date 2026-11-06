// After a successful send: raise an alert if more than 30% of feeds failed.
const c = $('Compose email & run stats').first().json;
const st = c.stats;
const ratio = st.feeds_total ? st.feeds_failed / st.feeds_total : 0;
const limit = Number($env.FEED_FAILURE_ALERT_RATIO || 0.3);
if (ratio <= limit) return [];
return [{ json: { alert_type: 'feed_failures', run_id: st.run_id, ratio, stats: st } }];
