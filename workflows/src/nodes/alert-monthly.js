// Monthly reminder: bias/reliability ratings change; re-verify them and update sources.json.
const cfg = loadConfig($env.DSB_CONFIG_DIR || '/data/config');
const rated = cfg.sources.sources.filter((s) => s.status === 'approved' && s.tier !== 'primary');
const rows = rated.map((s) => {
  const r = s.ratings || {};
  const fmt = (k, label) => { const x = r[k] || {}; const val = k === 'adfontes' ? (typeof x.bias === 'number' ? `bias ${x.bias}, reliability ${x.reliability}` : x.bias || 'n/a') : [x.bias, x.factual].filter(Boolean).join(', ') || 'n/a'; return `${label}: ${val}${x.url ? ' <' + x.url + '>' : ''}`; };
  return `${s.name} (${s.approval_basis === 'user_override' ? 'owner-approved exception' : 'passes 2-of-3 rule'}; last checked ${cfg.sources.ratings_checked_on})\n    ${fmt('allsides', 'AllSides')}\n    ${fmt('adfontes', 'Ad Fontes')}\n    ${fmt('mbfc', 'MBFC')}`;
});
const text = ['Monthly reminder: media bias and reliability ratings change over time. Please re-check each allowlisted outlet on AllSides, Ad Fontes Media and Media Bias/Fact Check, then update config/sources.json (ratings, "checked" dates and ratings_checked_on). Remove or flag any outlet that no longer qualifies.', '',
  `Ratings last recorded: ${cfg.sources.ratings_checked_on}. Outlets to check (${rated.length}):`, '', ...rows, '', 'Rule: approve only outlets rated Center/least-biased with high factual reliability by at least two of the three raters; anything else needs an explicit owner exception.'].join('\n');
return [{ json: { subject: 'Reminder: re-verify Defense Strategy Brief source ratings', text, html: '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1f2b;white-space:pre-wrap">' + escapeHtml(text).replace(/&lt;(https?:\/\/[^&]+)&gt;/g, '<a href="$1">$1</a>') + '</div>' } }];
