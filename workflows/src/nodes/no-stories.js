// No qualifying stories (or every summary failed validation): log the run and alert instead of sending an empty digest.
const pick = (n) => { try { const it = $(n).first(); return it && it.json && it.json.stats; } catch (e) { return null; } };
const stats = Object.assign({}, $input.first().json.stats || pick('Compose email & run stats') || pick('Select stories & fetch article text') || pick('Prefilter & build classification requests') || pick('Drop sent URLs & build embedding request') || {});
stats.stories_sent = 0;
stats.finished_at = new Date().toISOString();
return [{ json: { alert_type: 'no_stories', run_id: stats.run_id, status: 'no_stories', stats, sent_rows: [] } }];
