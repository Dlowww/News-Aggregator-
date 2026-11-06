// DSB_DRY_RUN=true: write the digest to disk instead of emailing it (URLs are not marked as sent).
const fs = require('fs');
const dir = $env.DSB_PREVIEW_DIR || '/data/previews';
const j = $input.first().json;
const name = j.html ? 'digest' : 'alert';
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(dir + '/' + name + '-latest.html', j.html || '');
fs.writeFileSync(dir + '/' + name + '-latest.txt', (j.text || '') + '');
fs.writeFileSync(dir + '/' + name + '-latest.json', JSON.stringify(j.stats || j, null, 2));
return [{ json: Object.assign({}, j, { preview_written_to: dir }) }];
