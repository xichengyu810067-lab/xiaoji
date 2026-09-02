const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const requiredFiles = [
  'website/index.html',
  'website/styles.css',
  'website/app.js',
  'website/assets/xiaoji-hero.png',
  'website/status.html',
  'website/status.css',
  'website/status.js',
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
const statusHtml = read('website/status.html');
const statusCss = read('website/status.css');
const statusApp = read('website/status.js');

new vm.Script(app, { filename: 'website/app.js' });
new vm.Script(statusApp, { filename: 'website/status.js' });
assert(html.includes('lang="zh-Hant"'), 'Official website must declare Traditional Chinese');
assert(html.includes('data-metric="guilds"'), 'Official website must show adopted guild count');
assert(html.includes('data-metric="interactions"'), 'Official website must show usage frequency');
assert(html.includes('今日互動'), 'Official website must label calendar-day usage without false rolling precision');
assert(html.includes('data-metric="status"'), 'Official website must show current status');
assert(html.includes('./status.html'), 'Official website must link to the realtime status page');
assert(html.includes('小吉'), 'Official website must consistently identify Xiaoji');
assert(css.includes('@media (max-width: 620px)'), 'Official website must include a mobile layout');
assert(css.includes('prefers-reduced-motion'), 'Official website must respect reduced-motion preferences');
assert(app.includes('/overview'), 'Official website must load the public overview endpoint');
assert(app.includes('todayInteractions'), 'Official website must use the Taipei calendar-day usage aggregate');
assert(!app.includes('last24hInteractions'), 'Official website must not claim unsupported rolling 24-hour precision');
assert(app.includes('schemaVersion !== 1'), 'Official website must fail closed on unknown API schema');
assert((html + app).includes('小吉不會用猜測的數字'), 'Official website must disclose unavailable live data');
assert(!/guildId|userId|discordId|ownerId/.test(html + app), 'Public website must not expose raw Discord identifiers');
assert(statusHtml.includes('正常'), 'Status website must explain the normal state');
assert(statusHtml.includes('維護中'), 'Status website must explain the maintenance state');
assert(statusHtml.includes('損壞'), 'Status website must explain the broken state');
assert(statusApp.includes('/status'), 'Status website must load the public status endpoint');
assert(statusApp.includes('replaceChildren'), 'Status website must render remote data without HTML injection');
assert(!/innerHTML|outerHTML|insertAdjacentHTML/.test(statusApp), 'Status website must not inject remote HTML');
assert(statusCss.includes('@media (max-width: 620px)'), 'Status website must include a mobile layout');
assert(!/guildId|userId|discordId|ownerId/.test(statusHtml + statusApp), 'Status website must not expose raw Discord identifiers');

const hero = fs.statSync(path.join(root, 'website/assets/xiaoji-hero.png'));
assert(hero.size >= 20_000, 'Xiaoji hero artwork appears to be missing or incomplete');

console.log('Official website checks passed.');
