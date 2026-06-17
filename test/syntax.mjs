// test/syntax.mjs - 语法 & JSON 校验
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve('.');
const jsFiles = ['background.js', 'content.js', 'popup.js'];
const jsonFiles = ['manifest.json'];

let failed = 0;

for (const f of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    console.log('OK   json', f);
  } catch (e) {
    failed++;
    console.error('FAIL json', f, e.message);
  }
}

for (const f of jsFiles) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  try {
    new vm.Script(src, { filename: f });
    console.log('OK   js  ', f);
  } catch (e) {
    failed++;
    console.error('FAIL js  ', f, e.message);
  }
}

// HTML 简单成对检查
const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
const opens = (html.match(/<[a-zA-Z][^/>]*?>/g) || []).length;
const closes = (html.match(/<\/[a-zA-Z][^>]*?>/g) || []).length;
console.log('INFO html tags open/close:', opens, '/', closes);

if (failed) {
  console.error('--- ' + failed + ' file(s) failed ---');
  process.exit(1);
} else {
  console.log('--- syntax check passed ---');
}
