// Stage-1 relevance: keyword hits (with a defense-context term) OR embedding similarity to a priority.
// Emits one item per candidate with its Ollama classification request.
const cfg = loadConfig($env.DSB_CONFIG_DIR || '/data/config');
const prev = $('Drop sent URLs & build embedding request').first().json;
const emb = ($input.first().json && $input.first().json.embeddings) || [];
const n = prev.embed_body.input.length;
if (emb.length !== n) throw new Error(`Ollama returned ${emb.length} embeddings for ${n} inputs (is ${prev.embed_body.model} pulled?)`);
const np = prev.n_priorities;
const pe = emb.slice(0, np);
const pf = cfg.topics.prefilter;
const stats = Object.assign({}, prev.stats);
const arts = prev.articles.map((a, i) => {
  const e = emb[np + i];
  let best = -1, bestId = null;
  pe.forEach((v, j) => { const c = cosine(e, v); if (c > best) { best = c; bestId = cfg.topics.priorities[j].id; } });
  const hits = Object.values(a.kw).reduce((s, h) => s + h.length, 0);
  const kwPass = a.context && Object.keys(a.kw).length >= (pf.min_keyword_hits || 1);
  return Object.assign(a, { embedding: e, max_sim: Math.round(best * 1000) / 1000, sim_priority: bestId, kw_hits: hits, prefilter_pass: kwPass || best >= pf.embedding_threshold, prefilter_score: best + Math.min(hits, 5) * 0.05 });
});
const passed = arts.filter((a) => a.prefilter_pass).sort((x, y) => y.prefilter_score - x.prefilter_score);
const cap = (cfg.topics.digest && cfg.topics.digest.max_classify) || 90;
stats.prefilter_pass = passed.length;
stats.prefilter_capped = Math.max(0, passed.length - cap);
const model = $env.OLLAMA_MODEL;
if (!model) throw new Error('OLLAMA_MODEL is not set');
const sel = passed.slice(0, cap);
if (!sel.length) return [{ json: { no_candidates: true, stats } }];
return sel.map((a, i) => ({ json: { article: a, classify_body: buildClassifyBody(a, cfg, model), stats: i === 0 ? stats : undefined } }));
