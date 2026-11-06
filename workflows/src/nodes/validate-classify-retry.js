// Final validation after the single retry. Items that still fail are kept as {failed:true} so they are counted.
const cfg = loadConfig($env.DSB_CONFIG_DIR || '/data/config');
return $input.all().map((it, i) => {
  const src = $('Validate classifications').itemMatching(i).json;
  if (it.json.error) return { json: { failed: true, article_id: src.article.id, errors: ['retry request failed: ' + (it.json.error.message || '')] } };
  const p = parseLlmJson(it.json);
  const v = p.error ? { ok: false, errors: [p.error] } : validateClassification(p.value, cfg.topics);
  return v.ok ? { json: { needs_retry: false, retried: true, article: Object.assign({}, src.article, { relevance: v.value }) } }
              : { json: { failed: true, article_id: src.article.id, errors: v.errors } };
});
