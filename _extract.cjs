const fs = require('fs');
const s = fs.readFileSync('index.html', 'utf8');
const marker = '<script type="module">';
const i = s.lastIndexOf(marker);
const j = s.indexOf('</script>', i);
if (i < 0 || j < 0) throw new Error('module script not found');
const code = s.slice(i + marker.length, j);
fs.writeFileSync('_syntax-check.mjs', code);
console.log('extracted lines:', code.split('\n').length);
