const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { createServer } = require('../server.cjs');

test('static server preserves app assets and allows recorded audio, WASM and P2P connections', async (t) => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [url, file, type] of [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js?v=server', 'app.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
    ['/vendor/noise-suppressor/rnnoise.wasm', path.join('vendor', 'noise-suppressor', 'rnnoise.wasm'), 'application/wasm'],
    ['/vendor/noise-suppressor/rnnoiseWorklet.js', path.join('vendor', 'noise-suppressor', 'rnnoiseWorklet.js'), 'text/javascript; charset=utf-8'],
  ]) {
    const response = await fetch(base + url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), type);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(path.join(__dirname, '..', file)));
    const policy = response.headers.get('content-security-policy');
    assert.match(policy, /media-src 'self' blob: https: http:/);
    assert.match(policy, /script-src 'self' 'wasm-unsafe-eval' https:/);
    assert.match(policy, /connect-src 'self' https: http: wss: ws:/);
    assert.match(policy, /worker-src 'self' blob:/);
    assert.equal(response.headers.get('permissions-policy'), 'microphone=(self)');
  }
});

test('cache revalidation and HEAD preserve headers without sending stale content', async (t) => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/app.js`;
  const first = await fetch(url);
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const body = await first.arrayBuffer();
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), body.byteLength);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const cached = await fetch(url, { headers: { 'If-None-Match': first.headers.get('etag') } });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get('cache-control'), 'no-cache');
  const changed = await fetch(url, { headers: { 'If-None-Match': '"old-version"' } });
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.arrayBuffer(), body);
});

test('Tokyvideo page URLs resolve to the official embed without accepting arbitrary hosts', async (t) => {
  const upstreamRequests = [];
  const server = createServer({
    fetchImpl: async (url) => {
      upstreamRequests.push(url);
      return new Response(
        '<input value=\'<iframe src="https://www.tokyvideo.com/embed/789077"></iframe>\'>',
        { status: 200, headers: { 'Content-Type': 'text/html' } },
      );
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const pageUrl = 'https://www.tokyvideo.com/video/sample-video';
  const resolved = await fetch(`${base}/api/tokyvideo-embed?url=${encodeURIComponent(pageUrl)}`);
  assert.equal(resolved.status, 200);
  assert.deepEqual(await resolved.json(), { embedUrl: 'https://www.tokyvideo.com/embed/789077' });
  assert.deepEqual(upstreamRequests, [pageUrl]);

  const rejected = await fetch(`${base}/api/tokyvideo-embed?url=${encodeURIComponent('https://example.com/video/sample-video')}`);
  assert.equal(rejected.status, 400);
  assert.equal(upstreamRequests.length, 1);
});

test('private files, malformed paths and unsupported methods are not served', async (t) => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const url of ['/server.cjs', '/package.json', '/.git/config', '/%2e%2e%2fapp.js', '/%5capp.js', '/missing.js']) {
    const response = await fetch(base + url);
    assert.equal(response.status, 404, url);
  }
  assert.equal((await fetch(base + '/%ZZ')).status, 400);
  const rejected = await fetch(base, { method: 'POST' });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('allow'), 'GET, HEAD');
});
