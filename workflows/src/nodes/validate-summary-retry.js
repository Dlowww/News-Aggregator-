// Final summary validation after one retry. Stories that still fail are dropped (and counted).
const cfg = loadConfig($env.DSB_CONFIG_DIR || '/data/config');
return $input.all().map((it, i) => {
  const src = $('Validate summaries').itemMatching(i).json;
  if (it.json.error) return { json: { failed: true, story_id: src.story.id, errors: ['retry request failed'] } };
  const p = parseLlmJson(it.json);
  const v = p.error ? { ok: false, errors: [p.error] } : validateSummary(p.value, cfg.prompts);
  return v.ok ? { json: { retried: true, story: Object.assign({}, src.story, { written: v.value }) } } : { json: { failed: true, story_id: src.story.id, errors: v.errors } };
});
