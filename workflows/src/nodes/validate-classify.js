// Validates Ollama's classification JSON. Malformed answers are routed to one retry.
const cfg = loadConfig($env.DSB_CONFIG_DIR || '/data/config');
const model = $env.OLLAMA_MODEL;
const out = [];
$input.all().forEach((it, i) => {
  const src = $('Prefilter & build classification requests').itemMatching(i).json;
  let errors;
  if (it.json.error) errors = ['request failed: ' + (it.json.error.message || 'unknown error')];
  else {
    const p = parseLlmJson(it.json);
    const v = p.error ? { ok: false, errors: [p.error] } : validateClassification(p.value, cfg.topics);
    if (v.ok) { out.push({ json: { needs_retry: false, article: Object.assign({}, src.article, { relevance: v.value }) } }); return; }
    errors = v.errors;
  }
  const note = cfg.prompts.retry_note.replace('{{errors}}', errors.join('; '));
  out.push({ json: { needs_retry: true, errors, article: src.article, retry_body: buildClassifyBody(src.article, cfg, model, note) } });
});
return out;
