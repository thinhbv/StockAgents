import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../src/router.js';
import { serveStatic } from '../src/static.js';
import { loadApiConfig } from '../src/config.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

test('router khớp đường dẫn tĩnh', () => {
  const r = createRouter();
  const h = () => 'ok';
  r.get('/api/session', h);
  const m = r.resolve('/api/session');
  assert.equal(m.handler, h);
  assert.deepEqual(m.params, {});
});

test('router rút tham số đường dẫn', () => {
  const r = createRouter();
  r.get('/api/agents/:id/positions', () => {});
  const m = r.resolve('/api/agents/claude_value/positions');
  assert.deepEqual(m.params, { id: 'claude_value' });
});

test('router không khớp thì trả null', () => {
  const r = createRouter();
  r.get('/api/session', () => {});
  assert.equal(r.resolve('/api/nope'), null);
  assert.equal(r.resolve('/api/session/extra'), null);
});

test('router ưu tiên route ÍT tham số hơn khi cùng độ dài', () => {
  const r = createRouter();
  const withParam = () => 'param';
  const staticRoute = () => 'static';
  r.get('/api/agents/:id', withParam);
  r.get('/api/agents/tong-hop', staticRoute);
  assert.equal(r.resolve('/api/agents/tong-hop').handler, staticRoute);
  assert.equal(r.resolve('/api/agents/a1').handler, withParam);
});

test('serveStatic trả index.html cho gốc', async () => {
  const res = await serveStatic(PUBLIC, '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
});

test('serveStatic đặt đúng content-type cho css và js', async () => {
  assert.match((await serveStatic(PUBLIC, '/style.css')).headers['content-type'], /text\/css/);
  assert.match((await serveStatic(PUBLIC, '/app.js')).headers['content-type'], /javascript/);
});

test('serveStatic CHẶN path traversal', async () => {
  for (const attack of ['/../../../.env', '/..%2f..%2f.env', '/./../package.json']) {
    const res = await serveStatic(PUBLIC, attack);
    assert.notEqual(res.status, 200, `${attack} không được phép đọc`);
  }
});

test('serveStatic trả 404 cho file không tồn tại', async () => {
  assert.equal((await serveStatic(PUBLIC, '/khong-co.html')).status, 404);
});

test('loadApiConfig mặc định bind localhost', () => {
  const c = loadApiConfig({ DATABASE_URL_READONLY: 'postgres://x' });
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 8080);
});

test('loadApiConfig TỪ CHỐI mở ra ngoài localhost khi không có token', () => {
  assert.throws(
    () => loadApiConfig({ DATABASE_URL_READONLY: 'postgres://x', DASHBOARD_HOST: '0.0.0.0' }),
    /DASHBOARD_TOKEN/,
  );
});

test('loadApiConfig cho phép mở ra ngoài khi có token', () => {
  const c = loadApiConfig({
    DATABASE_URL_READONLY: 'postgres://x', DASHBOARD_HOST: '0.0.0.0', DASHBOARD_TOKEN: 'secret',
  });
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.token, 'secret');
});

test('loadApiConfig báo lỗi rõ khi thiếu DATABASE_URL_READONLY', () => {
  assert.throws(() => loadApiConfig({}), /DATABASE_URL_READONLY/);
});
