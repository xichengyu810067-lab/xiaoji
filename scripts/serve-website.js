const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const websiteRoot = path.resolve(__dirname, '..', 'website');
const requestedPort = Number.parseInt(process.env.WEBSITE_PORT || '4173', 10);
const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535
  ? requestedPort
  : 4173;
const gameProxyPort = Number.parseInt(process.env.GAME_PREVIEW_PORT || '8790', 10);

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

function resolveRequestPath(requestUrl) {
  try {
    const pathname = new URL(requestUrl, 'http://localhost').pathname;
    const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const candidate = path.resolve(websiteRoot, relativePath);
    return candidate === websiteRoot || candidate.startsWith(`${websiteRoot}${path.sep}`) ? candidate : null;
  } catch (_error) {
    return null;
  }
}

function proxyGameRequest(request, response) {
  const proxy = http.request({
    host: '127.0.0.1',
    port: gameProxyPort,
    method: request.method,
    path: request.url,
    headers: {
      Accept: 'application/json',
      'Content-Type': request.headers['content-type'] || 'application/json',
      Origin: `http://127.0.0.1:${port}`,
    },
  }, (upstream) => {
    response.writeHead(upstream.statusCode || 502, {
      'Content-Type': upstream.headers['content-type'] || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    upstream.pipe(response);
  });
  proxy.setTimeout(6000, () => proxy.destroy(new Error('preview proxy timeout')));
  proxy.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: 'game_preview_unavailable' }));
  });
  request.pipe(proxy);
}

const server = http.createServer((request, response) => {
  if (request.url === '/api/games/session/exchange' || request.url === '/api/games/action') {
    proxyGameRequest(request, response);
    return;
  }
  const filePath = resolveRequestPath(request.url || '/');
  if (!filePath) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    const resolvedPath = !statError && stats.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    fs.readFile(resolvedPath, (readError, contents) => {
      if (readError) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end('Not found');
        return;
      }

      response.writeHead(200, {
        'Content-Type': mimeTypes.get(path.extname(resolvedPath).toLowerCase()) || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(contents);
    });
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Xiaoji website preview: http://127.0.0.1:${port}`);
});
