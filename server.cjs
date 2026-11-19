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

function tokyoVideoInput(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!['tokyvideo.com', 'www.tokyvideo.com'].includes(host) || url.port || !['http:', 'https:'].includes(url.protocol)) return null;
  if (url.username || url.password) return null;

  if (/^\/embed\/\d+\/?$/.test(url.pathname)) {
    const id = url.pathname.match(/^\/embed\/(\d+)/)[1];
    return { embedUrl: `https://www.tokyvideo.com/embed/${id}` };
  }
  if (/^\/video\/[^/]+\/?$/.test(url.pathname)) {
    return { pageUrl: `https://www.tokyvideo.com${url.pathname}` };
  }
  return null;
}

async function readTokyvideoPage(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2 * 1024 * 1024) {
      await reader.cancel();
      const error = new Error('Tokyvideo page exceeded the size limit');
      error.statusCode = 502;
      throw error;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function resolveTokyvideoEmbed(raw, fetchImpl) {
  const parsed = tokyoVideoInput(raw);
  if (!parsed) {
    const error = new Error('URL do Tokyvideo inválida');
    error.statusCode = 400;
    throw error;
  }
  if (parsed.embedUrl) return parsed.embedUrl;

  let pageUrl = parsed.pageUrl;
  let response;
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await fetchImpl(pageUrl, {
      headers: { Accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status < 300 || response.status >= 400) break;

    const location = response.headers.get('location');
    const nextUrl = location ? new URL(location, pageUrl) : null;
    if (!nextUrl || !tokyoVideoInput(nextUrl.href) || redirects === 3) {
      const error = new Error('Redirecionamento inválido ao consultar o Tokyvideo');
      error.statusCode = 502;
      throw error;
    }
    pageUrl = nextUrl.href;
  }

  if (!response.ok) {
    const error = new Error('Tokyvideo returned an unsuccessful response');
    error.statusCode = response.status === 404 ? 404 : 502;
    throw error;
  }
  const html = await readTokyvideoPage(response);
  const match = html.match(/https?:\/\/(?:www\.)?tokyvideo\.com\/embed\/(\d+)/i);
  if (!match) {
    const error = new Error('Não foi possível encontrar o player deste vídeo no Tokyvideo');
    error.statusCode = 422;
    throw error;
  }
  return `https://www.tokyvideo.com/embed/${match[1]}`;
}

function createServer({ fetchImpl = globalThis.fetch } = {}) {
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

    let requestUrl;
    try {
      requestUrl = new URL(req.url, 'http://localhost');
    } catch (error) {
      console.warn('[servidor] URL inválida:', error.message);
      res.writeHead(400).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(requestUrl.pathname);
    } catch (error) {
      console.warn('[servidor] URL inválida:', error.message);
      res.writeHead(400).end();
      return;
    }

    if (pathname === '/api/tokyvideo-embed') {
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' }).end();
        return;
      }
      try {
        const embedUrl = await resolveTokyvideoEmbed(requestUrl.searchParams.get('url') || '', fetchImpl);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ embedUrl }));
      } catch (error) {
        const status = Number.isInteger(error.statusCode) ? error.statusCode : 502;
        if (status >= 500) console.warn('[servidor] não foi possível resolver vídeo do Tokyvideo:', error.message);
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          error: status === 404 ? 'Vídeo do Tokyvideo não encontrado.'
            : status === 422 ? 'Não foi possível localizar o player deste vídeo.'
              : status === 400 ? 'URL do Tokyvideo inválida.'
                : 'Não foi possível consultar o Tokyvideo.',
        }));
      }
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
