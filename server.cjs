const http = require('node:http');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');

const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https: http: wss: ws:",
  "media-src 'self' blob: https: http:",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
].join('; ');

function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Permissions-Policy', 'microphone=(self)');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (error) {
      console.warn('[servidor] URL inválida:', error.message);
      res.writeHead(400).end();
      return;
    }
    const file = path.resolve(ROOT, '.' + (pathname === '/' ? '/index.html' : pathname));
    const type = MIME[path.extname(file)];
    if (!file.startsWith(ROOT + path.sep) || /(?:^|\/)\./.test(pathname) || pathname.includes('\\') || !type) {
      res.writeHead(404).end();
      return;
    }

    try {
      const info = await stat(file);
      if (!info.isFile()) {
        res.writeHead(404).end();
        return;
      }
      const etag = `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
      res.setHeader('Content-Type', type);
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', info.mtime.toUTCString());
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304).end();
        return;
      }
      const body = req.method === 'HEAD' ? null : await readFile(file);
      res.writeHead(200, { 'Content-Length': body ? body.length : info.size });
      res.end(body);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        res.writeHead(404).end();
      } else {
        console.error('[servidor] falha ao servir arquivo:', error);
        res.writeHead(500).end();
      }
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT deve ser uma porta válida entre 1 e 65535');
  const server = createServer();
  server.on('error', (error) => {
    console.error('[servidor] falha ao iniciar:', error);
    process.exitCode = 1;
  });
  server.listen(port, '0.0.0.0', () => console.log(`[servidor] CinemaOnline na porta ${port}`));
}

module.exports = { createServer };
