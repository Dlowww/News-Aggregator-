// Validates summary JSON and neutrality rules; failures get one retry with the reasons.
const cfg = loadConfig($env.DSB_CONFIG_DIR || '/data/config');
const model = $env.OLLAMA_MODEL;
return $input.all().map((it, i) => {
  const src = $('Select stories & fetch article text').itemMatching(i).json;
  let errors;
  if (it.json.error) errors = ['request failed: ' + (it.json.error.message || '')];
  else {
    const p = parseLlmJson(it.json);
    const v = p.error ? { ok: false, errors: [p.error] } : validateSummary(p.value, cfg.prompts);
    if (v.ok) return { json: { needs_retry: false, story: Object.assign({}, src.story, { written: v.value }) } };
    errors = v.errors;
  }
  const note = cfg.prompts.retry_note.replace('{{errors}}', errors.join('; '));
  return { json: { needs_retry: true, errors, story: src.story, retry_body: buildSummaryBody(src.story, cfg, model, note) } };
});
