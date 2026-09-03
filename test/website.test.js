const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');

test('official website is localized, responsive, and honest when live data is unavailable', () => {
  const html = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'website/styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'website/app.js'), 'utf8');

  new vm.Script(app, { filename: 'website/app.js' });
  assert.match(html, /lang="zh-Hant"/);
  assert.match(html, /採用伺服器/);
  assert.match(html, /今日互動/);
  assert.match(html, /目前狀態/);
  assert.match(html, /\.\/status\.html/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(app, /schemaVersion !== 1/);
  assert.match(app, /dataNotice\.hidden = true/);
  assert.match(css, /\.data-notice\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(html + app, /小吉不會用猜測的數字/);
});

test('official website public data contract contains no Discord identity fields', () => {
  const html = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'website/app.js'), 'utf8');

  assert.doesNotMatch(html + app, /guildId|userId|discordId|ownerId/);
  assert.match(app, /guilds\?\.adoptedCount/);
  assert.match(app, /usage\?\.todayInteractions/);
  assert.doesNotMatch(app, /last24hInteractions/);
  assert.match(app, /bot\?\.status/);
});

test('realtime status site renders only allowlisted states with text-safe DOM operations', () => {
  const html = fs.readFileSync(path.join(root, 'website/status.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'website/status.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'website/status.js'), 'utf8');

  new vm.Script(app, { filename: 'website/status.js' });
  assert.match(html, /正常/);
  assert.match(html, /維護中/);
  assert.match(html, /損壞/);
  assert.match(app, /FEATURE_STATUS/);
  assert.match(app, /replaceChildren/);
  assert.doesNotMatch(app, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(html + app, /沒有資料.*正常|狀態未知/s);
  assert.doesNotMatch(html + app, /guildId|userId|discordId|ownerId/);
});
