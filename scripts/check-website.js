const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const requiredFiles = [
  'website/index.html',
  'website/styles.css',
  'website/app.js',
  'website/assets/xiaoji-hero.png',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

for (const file of requiredFiles) {
  assert(fs.existsSync(path.join(root, file)), `Missing website file: ${file}`);
}

const html = read('website/index.html');
const css = read('website/styles.css');
const app = read('website/app.js');

new vm.Script(app, { filename: 'website/app.js' });
assert(html.includes('lang="zh-Hant"'), 'Official website must declare Traditional Chinese');
assert(html.includes('data-metric="guilds"'), 'Official website must show adopted guild count');
assert(html.includes('data-metric="interactions"'), 'Official website must show usage frequency');
assert(html.includes('data-metric="status"'), 'Official website must show current status');
assert(html.includes('./status.html'), 'Official website must link to the realtime status page');
assert(html.includes('小吉'), 'Official website must consistently identify Xiaoji');
assert(css.includes('@media (max-width: 620px)'), 'Official website must include a mobile layout');
assert(css.includes('prefers-reduced-motion'), 'Official website must respect reduced-motion preferences');
assert(app.includes('/overview'), 'Official website must load the public overview endpoint');
assert(app.includes('schemaVersion !== 1'), 'Official website must fail closed on unknown API schema');
assert((html + app).includes('小吉不會用猜測的數字'), 'Official website must disclose unavailable live data');
assert(!/guildId|userId|discordId|ownerId/.test(html + app), 'Public website must not expose raw Discord identifiers');

const hero = fs.statSync(path.join(root, 'website/assets/xiaoji-hero.png'));
assert(hero.size >= 20_000, 'Xiaoji hero artwork appears to be missing or incomplete');

console.log('Official website checks passed.');
