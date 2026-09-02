const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const websiteRoot = path.resolve(__dirname, '..', 'website');
const requestedPort = Number.parseInt(process.env.WEBSITE_PORT || '4173', 10);
const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535
  ? requestedPort
  : 4173;

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

function resolveRequestPath(requestUrl) {
  const pathname = new URL(requestUrl, 'http://localhost').pathname;
  const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const candidate = path.resolve(websiteRoot, relativePath);
  return candidate === websiteRoot || candidate.startsWith(`${websiteRoot}${path.sep}`) ? candidate : null;
}

const server = http.createServer((request, response) => {
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
