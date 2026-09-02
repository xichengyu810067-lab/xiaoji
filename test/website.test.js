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
  assert.match(html, /24 小時互動/);
  assert.match(html, /目前狀態/);
  assert.match(html, /\.\/status\.html/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(app, /schemaVersion !== 1/);
  assert.match(html + app, /小吉不會用猜測的數字/);
});

test('official website public data contract contains no Discord identity fields', () => {
  const html = fs.readFileSync(path.join(root, 'website/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'website/app.js'), 'utf8');

  assert.doesNotMatch(html + app, /guildId|userId|discordId|ownerId/);
  assert.match(app, /guilds\?\.adoptedCount/);
  assert.match(app, /usage\?\.last24hInteractions/);
  assert.match(app, /bot\?\.status/);
});
