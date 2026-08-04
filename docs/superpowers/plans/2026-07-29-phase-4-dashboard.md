# Phase 4 — API & Realtime Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mở trình duyệt thấy agent chạy realtime — trạng thái, lý luận, chiến lược, danh mục — làm công cụ quan sát cho mọi phase sau.

**Architecture:** Tiến trình `api` riêng, `LISTEN agent_events` trên PostgreSQL và fan-out qua Server-Sent Events. `event_log` là nguồn sự thật duy nhất: mỗi message SSE mang `id` bằng `event_log.id`, nên trình duyệt mất kết nối chỉ cần gửi `Last-Event-ID` là được phát lại phần thiếu. Chỉ đọc — không có endpoint ghi, và kết nối DB dùng role chỉ có quyền `SELECT`.

**Tech Stack:** Node.js `node:http` (không thêm dependency), PostgreSQL 18, `pg`, HTML/CSS/JS thuần không build step.

## Global Constraints

- JavaScript ESM only. Không TypeScript, không build step. Node >= 20.20.
- **Chạy test bằng `npm test`.** Không dùng glob hay thư mục với `node --test`.
- **Không thêm dependency mới.** Xem "Sai lệch có chủ đích" bên dưới.
- Mọi hàm repository chạm bảng có `agent_id` bắt buộc gọi `assertAgentScope`.
- Không sửa gì trong `tradingview_mcp/`.
- Mọi file test **tự chứa**: chạy riêng được, chạy hai lần liên tiếp vẫn xanh.
- Conventional Commits. Tác giả: `git -c user.email=claudeai07@vhec.vn -c user.name="Claude"`.

## Sai lệch có chủ đích so với spec §11

Spec ghi **Fastify**. Plan này dùng **`node:http`**.

Lý do: dự án hiện có đúng ba dependency và đã cố tình từ chối SDK Anthropic lẫn test framework. API này là 8 endpoint GET chỉ đọc cộng một luồng SSE — routing vừa đủ một bảng tra, static file là `readFile` + content-type, SSE là ghi header rồi ghi dòng. Thêm Fastify cùng cây phụ thuộc của nó cho ngần đó việc là không cân xứng, và nó là bề mặt phải vá về sau.

Đổi lại: phải tự viết ~80 dòng routing/static/SSE. Có test cho từng phần.

## Nguyên tắc chi phối Phase này

**Chỉ đọc phải được cưỡng chế ở tầng database, không phải chỉ ở tầng route.** Một route viết sai vẫn không được phép ghi. Vì vậy `api` kết nối bằng role PostgreSQL riêng chỉ có `SELECT` (và `LISTEN`). Kể cả khi có lỗ hổng injection, thứ tệ nhất xảy ra là đọc trộm — không phải sửa danh mục.

**Không được có khoảng trống giữa lịch sử và realtime.** Trình duyệt nạp lịch sử qua `/api/events?since=0` rồi mở SSE từ `id` lớn nhất đã nhận. Nếu SSE bắt đầu từ "bây giờ" thay vì từ con trỏ, mọi sự kiện xảy ra giữa hai lời gọi sẽ mất vĩnh viễn.

## File Structure

| File | Trách nhiệm |
|---|---|
| `packages/db/migrations/008_readonly_role.sql` | Role `stockagents_ro` chỉ có SELECT |
| `packages/api/package.json` | Manifest |
| `packages/api/src/config.js` | Cấu hình riêng của api (host, port, token) |
| `packages/api/src/router.js` | Bảng tra route + so khớp tham số đường dẫn |
| `packages/api/src/static.js` | Phục vụ file tĩnh, chống path traversal |
| `packages/api/src/routes.js` | 8 handler chỉ đọc |
| `packages/api/src/stream/listener.js` | pg LISTEN → gọi lại người đăng ký |
| `packages/api/src/stream/sse.js` | Quản lý client SSE, phát lại theo Last-Event-ID |
| `packages/api/src/server.js` | Ghép lại, entry point |
| `packages/api/public/index.html` | Khung trang |
| `packages/api/public/app.js` | Dựng DOM từ dữ liệu và sự kiện |
| `packages/api/public/style.css` | Giao diện |

---

### Task 1: Role chỉ đọc

**Files:**
- Create: `packages/db/migrations/008_readonly_role.sql`
- Modify: `.env.example`
- Test: `packages/db/tests/readonly_role.test.js`

**Interfaces:**
- Produces: role PostgreSQL `stockagents_ro`, biến env `DATABASE_URL_READONLY`

- [ ] **Step 1: Tạo migration**

`packages/db/migrations/008_readonly_role.sql`:

```sql
-- API dashboard chỉ được ĐỌC. Cưỡng chế ở tầng database chứ không phải
-- chỉ ở tầng route: một route viết sai, hoặc một lỗ hổng injection, vẫn
-- không được phép sửa danh mục của agent.
--
-- Mật khẩu đặt qua biến môi trường lúc chạy migration, không nhúng vào file.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stockagents_ro') THEN
    EXECUTE format('CREATE ROLE stockagents_ro LOGIN PASSWORD %L',
                   coalesce(current_setting('stockagents.ro_password', true), 'readonly'));
  END IF;
END $$;

GRANT CONNECT ON DATABASE CURRENT_CATALOG TO stockagents_ro;
GRANT USAGE ON SCHEMA public TO stockagents_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO stockagents_ro;

-- Bảng tạo sau này cũng tự có quyền SELECT, và CHỈ SELECT.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO stockagents_ro;
```

- [ ] **Step 2: Thêm biến vào `.env.example` và `.env`**

```env
DATABASE_URL_READONLY=postgres://stockagents_ro:readonly@localhost:5432/stockagents

DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=8080
DASHBOARD_TOKEN=
EVENT_LOG_RETENTION_DAYS=90
```

- [ ] **Step 3: Viết test chứng minh role KHÔNG ghi được**

`packages/db/tests/readonly_role.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { withTestDb } from '../../../tests/helpers/db.js';

let admin, ro;

before(async () => {
  admin = await withTestDb();   // chạy migration, tạo role
  const url = loadConfig().databaseUrlTest
    .replace(/\/\/[^:]+:[^@]+@/, '//stockagents_ro:readonly@');
  ro = createClient(url);
});
after(async () => { await admin.close(); await ro.close(); });

test('role chỉ đọc ĐỌC được dữ liệu', async () => {
  const { rows } = await ro.query('SELECT count(*)::int n FROM agents');
  assert.ok(Number.isInteger(rows[0].n));
});

test('role chỉ đọc KHÔNG ghi được — đây là hàng rào thật, không phải quy ước', async () => {
  await assert.rejects(
    ro.query(`INSERT INTO event_log (type, payload) VALUES ('hack','{}')`),
    /permission denied/,
  );
});

test('role chỉ đọc không xoá được', async () => {
  await assert.rejects(ro.query('DELETE FROM event_log'), /permission denied/);
});

test('role chỉ đọc không sửa được danh mục', async () => {
  await assert.rejects(ro.query('UPDATE agents SET cash_vnd = 0'), /permission denied/);
});
```

- [ ] **Step 4: Chạy migration rồi chạy test**

```bash
npm run migrate
node packages/db/src/migrate.js --test
node --test packages/db/tests/readonly_role.test.js
node --test packages/db/tests/readonly_role.test.js
npm test
```

Kỳ vọng: 4/4 cả hai lần; toàn suite xanh.

- [ ] **Step 5: Commit**

```bash
git add packages/db .env.example
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(db): read-only role so the dashboard cannot write"
```

---

### Task 2: Router và phục vụ file tĩnh

**Files:**
- Create: `packages/api/package.json`, `packages/api/src/config.js`
- Create: `packages/api/src/router.js`, `packages/api/src/static.js`
- Test: `packages/api/tests/router.test.js`

**Interfaces:**
- Produces:
  - `loadApiConfig(env)` → `{ host, port, token, readonlyUrl }`; throw nếu `host` khác `127.0.0.1` mà thiếu token
  - `createRouter()` → `{ get(pattern, handler), resolve(pathname) → { handler, params } | null }`
  - pattern hỗ trợ `:param`, ví dụ `/api/agents/:id/positions`
  - `serveStatic(rootDir, urlPath)` → `{ status, headers, body }`; chặn path traversal

- [ ] **Step 1: Tạo `packages/api/package.json`**

```json
{
  "name": "@stockagents/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/server.js",
  "dependencies": {
    "@stockagents/db": "*"
  }
}
```

Chạy `npm install` ở gốc.

- [ ] **Step 2: Viết test thất bại**

`packages/api/tests/router.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/router.js';
import { serveStatic } from '../src/static.js';
import { loadApiConfig } from '../src/config.js';

const PUBLIC = new URL('../public/', import.meta.url).pathname;

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

test('router phân biệt route tĩnh với route có tham số', () => {
  const r = createRouter();
  const a = () => 'a';
  const b = () => 'b';
  r.get('/api/agents/:id', b);
  r.get('/api/leaderboard', a);
  assert.equal(r.resolve('/api/leaderboard').handler, a);
  assert.equal(r.resolve('/api/agents/x').handler, b);
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
```

- [ ] **Step 3: Chạy test, xác nhận thất bại**

```bash
node --test packages/api/tests/router.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/router.js'`.

- [ ] **Step 4: Cài đặt `packages/api/src/config.js`**

```js
import 'dotenv/config';

export function loadApiConfig(env = process.env) {
  const readonlyUrl = env.DATABASE_URL_READONLY;
  if (!readonlyUrl || readonlyUrl.trim() === '') {
    throw new Error(
      'loadApiConfig: thiếu DATABASE_URL_READONLY. Dashboard phải kết nối bằng ' +
      'role chỉ có quyền SELECT — xem migration 008_readonly_role.sql.');
  }

  const host = env.DASHBOARD_HOST ?? '127.0.0.1';
  const token = env.DASHBOARD_TOKEN ?? '';

  // Mở ra ngoài localhost mà không có token là để ngỏ toàn bộ lịch sử giao
  // dịch cho bất kỳ ai trong mạng. Chặn ở cấu hình, không phải ở tài liệu.
  if (host !== '127.0.0.1' && host !== 'localhost' && token.trim() === '') {
    throw new Error(
      `loadApiConfig: DASHBOARD_HOST='${host}' mở ra ngoài localhost nhưng ` +
      'DASHBOARD_TOKEN rỗng. Đặt token, hoặc để host là 127.0.0.1.');
  }

  return {
    host,
    port: Number(env.DASHBOARD_PORT ?? 8080),
    token: token.trim(),
    readonlyUrl,
  };
}
```

- [ ] **Step 5: Cài đặt `packages/api/src/router.js`**

```js
/**
 * Bảng tra route tối giản. Chỉ GET — API này không có phương thức ghi.
 */
export function createRouter() {
  const routes = [];

  function get(pattern, handler) {
    const parts = pattern.split('/').filter(Boolean);
    routes.push({ parts, handler });
  }

  function resolve(pathname) {
    const segs = pathname.split('/').filter(Boolean);
    // Route tĩnh khớp trước route có tham số: /api/agents/:id không được
    // nuốt /api/agents/leaderboard nếu sau này có route đó.
    const ordered = [...routes].sort(
      (a, b) => countParams(a.parts) - countParams(b.parts));

    for (const route of ordered) {
      if (route.parts.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const p = route.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segs[i]);
        else if (p !== segs[i]) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  return { get, resolve };
}

function countParams(parts) {
  return parts.filter(p => p.startsWith(':')).length;
}
```

- [ ] **Step 6: Cài đặt `packages/api/src/static.js`**

```js
import { readFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export async function serveStatic(rootDir, urlPath) {
  const root = resolve(rootDir);

  // Giải mã TRƯỚC khi kiểm tra: '%2e%2e%2f' cũng là '../'.
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { status: 400, headers: {}, body: 'đường dẫn không hợp lệ' };
  }

  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = resolve(join(root, rel));

  // Sau khi giải quyết mọi '..', file PHẢI còn nằm trong thư mục public.
  if (!target.startsWith(root)) {
    return { status: 403, headers: {}, body: 'cấm truy cập ngoài thư mục public' };
  }

  try {
    const body = await readFile(target);
    return {
      status: 200,
      headers: { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' },
      body,
    };
  } catch {
    return { status: 404, headers: {}, body: 'không tìm thấy' };
  }
}
```

- [ ] **Step 7: Chạy test hai lần và toàn suite**

```bash
node --test packages/api/tests/router.test.js
node --test packages/api/tests/router.test.js
npm test
```

Kỳ vọng: 12/12 cả hai lần; toàn suite xanh. (Test static cần `public/index.html`, `style.css`, `app.js` tồn tại — tạo file rỗng tạm nếu Task 5 chưa làm.)

- [ ] **Step 8: Commit**

```bash
git add packages/api package.json package-lock.json
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(api): router, static serving with traversal guard, and config"
```

---

### Task 3: SSE và pg LISTEN

**Files:**
- Create: `packages/api/src/stream/sse.js`
- Create: `packages/api/src/stream/listener.js`
- Test: `packages/api/tests/sse.test.js`

**Interfaces:**
- Consumes: `createEventsRepo` (Phase 1)
- Produces:
  - `createSseHub({ eventsRepo, heartbeatMs })` → `{ attach(res, lastEventId), broadcast(event), clientCount(), stop() }`
  - `attach` phát lại mọi sự kiện có `id > lastEventId` trước khi nối vào luồng trực tiếp
  - `createEventListener({ connectionString, onEvent, logger })` → `{ start(), stop() }`
  - `onEvent` nhận phong bì `{ id, type, agentId }` từ NOTIFY

- [ ] **Step 1: Viết test thất bại**

`packages/api/tests/sse.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createEventsRepo } from '@stockagents/db';
import { createSseHub } from '../src/stream/sse.js';

let client, eventsRepo;

// Giả lập http.ServerResponse: ghi lại mọi thứ được ghi ra.
function fakeRes() {
  const chunks = [];
  return {
    chunks,
    headersSent: null,
    writeHead(status, headers) { this.headersSent = { status, headers }; },
    write(s) { chunks.push(s); return true; },
    end() { this.ended = true; },
    on() {},
    get text() { return chunks.join(''); },
  };
}

before(async () => {
  client = await withTestDb();
  eventsRepo = createEventsRepo(client);
});
beforeEach(async () => { await resetTables(client, ['event_log']); });
after(async () => { await client.close(); });

test('attach đặt đúng header SSE', async () => {
  const hub = createSseHub({ eventsRepo });
  const res = fakeRes();
  await hub.attach(res, 0);

  assert.equal(res.headersSent.status, 200);
  assert.match(res.headersSent.headers['content-type'], /text\/event-stream/);
  assert.equal(res.headersSent.headers['cache-control'], 'no-cache');
  hub.stop();
});

test('broadcast gửi sự kiện đúng định dạng SSE kèm id', async () => {
  const hub = createSseHub({ eventsRepo });
  const res = fakeRes();
  await hub.attach(res, 0);

  hub.broadcast({ id: 42, type: 'trigger.fired', agentId: 'a1', payload: { x: 1 } });

  assert.match(res.text, /^id: 42$/m);
  assert.match(res.text, /^event: trigger\.fired$/m);
  assert.match(res.text, /^data: \{.*"x":1.*\}$/m);
  hub.stop();
});

test('attach PHÁT LẠI sự kiện đã bỏ lỡ theo Last-Event-ID', async () => {
  const a = await eventsRepo.appendEvent({ type: 'e1', payload: {} });
  await eventsRepo.appendEvent({ type: 'e2', payload: {} });
  await eventsRepo.appendEvent({ type: 'e3', payload: {} });

  const hub = createSseHub({ eventsRepo });
  const res = fakeRes();
  await hub.attach(res, a.id);   // đã thấy tới e1

  assert.match(res.text, /event: e2/);
  assert.match(res.text, /event: e3/);
  assert.equal(/event: e1/.test(res.text), false, 'không phát lại cái đã thấy');
  hub.stop();
});

test('không có khoảng trống: sự kiện chèn giữa lịch sử và realtime vẫn tới', async () => {
  await eventsRepo.appendEvent({ type: 'cu', payload: {} });
  const hub = createSseHub({ eventsRepo });
  const res = fakeRes();

  await hub.attach(res, 0);
  hub.broadcast({ id: 99, type: 'moi', agentId: null, payload: {} });

  assert.match(res.text, /event: cu/);
  assert.match(res.text, /event: moi/);
  hub.stop();
});

test('clientCount tăng giảm đúng', async () => {
  const hub = createSseHub({ eventsRepo });
  assert.equal(hub.clientCount(), 0);
  await hub.attach(fakeRes(), 0);
  await hub.attach(fakeRes(), 0);
  assert.equal(hub.clientCount(), 2);
  hub.stop();
  assert.equal(hub.clientCount(), 0);
});

test('broadcast tới MỌI client đang kết nối', async () => {
  const hub = createSseHub({ eventsRepo });
  const a = fakeRes(); const b = fakeRes();
  await hub.attach(a, 0); await hub.attach(b, 0);

  hub.broadcast({ id: 7, type: 'chung', agentId: null, payload: {} });
  assert.match(a.text, /event: chung/);
  assert.match(b.text, /event: chung/);
  hub.stop();
});

test('client ghi lỗi bị gỡ khỏi danh sách, không làm hỏng client khác', async () => {
  const hub = createSseHub({ eventsRepo });
  const bad = fakeRes();
  bad.write = () => { throw new Error('socket đã đóng'); };
  const good = fakeRes();
  await hub.attach(bad, 0); await hub.attach(good, 0);

  assert.doesNotThrow(() => hub.broadcast({ id: 1, type: 'x', agentId: null, payload: {} }));
  assert.equal(hub.clientCount(), 1);
  assert.match(good.text, /event: x/);
  hub.stop();
});

test('payload nhiều dòng vẫn đúng khuôn SSE', async () => {
  const hub = createSseHub({ eventsRepo });
  const res = fakeRes();
  await hub.attach(res, 0);

  hub.broadcast({ id: 5, type: 'x', agentId: null, payload: { reason: 'dòng một\ndòng hai' } });
  // JSON.stringify escape xuống dòng nên data: vẫn nằm trên MỘT dòng
  const dataLines = res.text.split('\n').filter(l => l.startsWith('data: '));
  assert.equal(dataLines.length, 1);
  hub.stop();
});

test('giới hạn số client đồng thời', async () => {
  const hub = createSseHub({ eventsRepo, maxClients: 2 });
  await hub.attach(fakeRes(), 0);
  await hub.attach(fakeRes(), 0);
  const third = fakeRes();
  await hub.attach(third, 0);

  assert.equal(hub.clientCount(), 2);
  assert.equal(third.headersSent.status, 503);
  hub.stop();
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/api/tests/sse.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/stream/sse.js'`.

- [ ] **Step 3: Cài đặt `packages/api/src/stream/sse.js`**

```js
const HEARTBEAT_MS = 25_000;
const MAX_CLIENTS = 20;

/**
 * Quản lý client SSE.
 *
 * Mỗi message mang `id` bằng event_log.id. Khi trình duyệt mất kết nối,
 * EventSource tự nối lại kèm header Last-Event-ID, và ta phát lại phần
 * thiếu — nên không có khoảng trống giữa lịch sử và realtime.
 */
export function createSseHub({ eventsRepo, heartbeatMs = HEARTBEAT_MS, maxClients = MAX_CLIENTS }) {
  const clients = new Set();

  // Comment định kỳ để proxy không cắt kết nối vì tưởng đã chết.
  const heartbeat = setInterval(() => {
    for (const res of [...clients]) safeWrite(res, ': heartbeat\n\n');
  }, heartbeatMs);
  heartbeat.unref?.();

  function safeWrite(res, text) {
    try {
      res.write(text);
      return true;
    } catch {
      clients.delete(res);
      return false;
    }
  }

  function format(event) {
    // JSON.stringify escape mọi xuống dòng, nên `data:` luôn nằm trên một
    // dòng duy nhất — đúng khuôn SSE mà không cần tự chẻ dòng.
    return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  async function attach(res, lastEventId = 0) {
    if (clients.size >= maxClients) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('quá nhiều kết nối dashboard');
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });

    clients.add(res);
    res.on('close', () => clients.delete(res));

    // Phát lại phần đã bỏ lỡ TRƯỚC khi nối vào luồng trực tiếp.
    const missed = await eventsRepo.getEventsSince(lastEventId, 500);
    for (const e of missed) safeWrite(res, format(e));
  }

  function broadcast(event) {
    const text = format(event);
    for (const res of [...clients]) safeWrite(res, text);
  }

  function stop() {
    clearInterval(heartbeat);
    for (const res of [...clients]) {
      try { res.end(); } catch { /* client đã đóng */ }
    }
    clients.clear();
  }

  return { attach, broadcast, clientCount: () => clients.size, stop };
}
```

- [ ] **Step 4: Cài đặt `packages/api/src/stream/listener.js`**

```js
import pg from 'pg';

const CHANNEL = 'agent_events';
const RECONNECT_MS = 2_000;

/**
 * Nghe NOTIFY trên kênh agent_events.
 *
 * Dùng pg.Client riêng chứ không lấy từ pool: LISTEN gắn với MỘT kết nối cụ
 * thể, còn pool có thể trả về kết nối khác cho truy vấn sau và đăng ký sẽ
 * lặng lẽ biến mất.
 */
export function createEventListener({ connectionString, onEnvelope, logger = console }) {
  let client = null;
  let stopped = false;
  let retryTimer = null;

  async function connect() {
    if (stopped) return;
    client = new pg.Client({ connectionString });

    client.on('notification', (msg) => {
      try {
        onEnvelope(JSON.parse(msg.payload));
      } catch (err) {
        logger.warn(`[listener] phong bì không đọc được: ${err.message}`);
      }
    });

    client.on('error', (err) => {
      logger.warn(`[listener] mất kết nối: ${err.message}`);
      scheduleReconnect();
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      logger.info(`[listener] đang nghe kênh ${CHANNEL}`);
    } catch (err) {
      logger.warn(`[listener] không kết nối được: ${err.message}`);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, RECONNECT_MS);
    retryTimer.unref?.();
  }

  async function stop() {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (client) { try { await client.end(); } catch { /* đã đóng */ } }
  }

  return { start: connect, stop };
}
```

- [ ] **Step 5: Chạy test hai lần và toàn suite**

```bash
node --test packages/api/tests/sse.test.js
node --test packages/api/tests/sse.test.js
npm test
```

Kỳ vọng: 9/9 cả hai lần; toàn suite xanh.

- [ ] **Step 6: Commit**

```bash
git add packages/api
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(api): SSE hub with gap-free replay and pg LISTEN listener"
```

---

### Task 4: Các route chỉ đọc và server

**Files:**
- Create: `packages/api/src/routes.js`
- Create: `packages/api/src/server.js`
- Modify: root `package.json` (script `api`)
- Test: `packages/api/tests/routes.test.js`

**Interfaces:**
- Consumes: repositories (Phase 1–3), `createRouter`, `createSseHub`, `serveStatic`
- Produces:
  - `createRoutes({ client, repos })` → object các handler `async ({ params, query }) => object`
  - `createServer({ config, client, hub, logger })` → `{ listen(), close() }`
  - 8 endpoint đúng spec §11.4

- [ ] **Step 1: Viết test thất bại**

`packages/api/tests/routes.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import {
  createAgentsRepo, createTradingRepo, createOpsRepo, createEventsRepo,
} from '@stockagents/db';
import { createRoutes } from '../src/routes.js';

let client, repos, routes;
const TABLES = ['trigger_log', 'position_lots', 'fills', 'orders', 'trade_outcomes',
  'trades', 'positions', 'portfolio_snapshot', 'metrics_daily', 'event_log',
  'session_state', 'agents', 'universe'];

before(async () => {
  client = await withTestDb();
  repos = {
    agents: createAgentsRepo(client), trading: createTradingRepo(client),
    ops: createOpsRepo(client), events: createEventsRepo(client),
  };
  routes = createRoutes({ client, repos });
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE')`);
  await repos.agents.upsertMany([
    { id: 'a1', name: 'Agent Một', provider: 'stub', model: 'stub',
      personaPrompt: 'kiên nhẫn', initialCapital: 1_000_000_000,
      riskConfig: { maxPositions: 8 } },
    { id: 'a2', name: 'Agent Hai', provider: 'stub', model: 'stub',
      personaPrompt: 'ngược dòng', initialCapital: 1_000_000_000 },
  ]);
});
after(async () => { await client.close(); });

test('GET /api/session trả trạng thái phiên', async () => {
  await repos.ops.setSessionState('2026-07-29', 'DATA_READY', { dataCapturedAt: new Date() });
  const r = await routes.session({ query: { date: '2026-07-29' } });
  assert.equal(r.state, 'DATA_READY');
});

test('GET /api/session không có dữ liệu thì nói rõ, không giả vờ ổn', async () => {
  const r = await routes.session({ query: { date: '2099-01-01' } });
  assert.equal(r.state, 'UNKNOWN');
});

test('GET /api/leaderboard liệt kê mọi agent kèm NAV', async () => {
  await repos.agents.saveSnapshot('a1', '2026-07-29',
    { cash: 900_000_000, marketValue: 150_000_000, nav: 1_050_000_000, dayPnl: 50_000_000 });
  const r = await routes.leaderboard({ query: {} });

  assert.equal(r.agents.length, 2);
  const a1 = r.agents.find(a => a.id === 'a1');
  assert.equal(a1.nav, 1_050_000_000);
  assert.equal(a1.name, 'Agent Một');
});

test('leaderboard sắp theo NAV giảm dần', async () => {
  await repos.agents.saveSnapshot('a1', '2026-07-29', { cash: 0, marketValue: 0, nav: 900_000_000, dayPnl: 0 });
  await repos.agents.saveSnapshot('a2', '2026-07-29', { cash: 0, marketValue: 0, nav: 1_100_000_000, dayPnl: 0 });
  const r = await routes.leaderboard({ query: {} });
  assert.deepEqual(r.agents.map(a => a.id), ['a2', 'a1']);
});

test('GET /api/agents/:id trả cấu hình nhưng KHÔNG lộ persona đầy đủ ra ngoài', async () => {
  const r = await routes.agent({ params: { id: 'a1' } });
  assert.equal(r.id, 'a1');
  assert.equal(r.model, 'stub');
  assert.ok(r.personaPrompt.length > 0);
});

test('GET /api/agents/:id với id không tồn tại trả 404', async () => {
  await assert.rejects(() => routes.agent({ params: { id: 'khong-co' } }), /404/);
});

test('GET /api/agents/:id/positions chỉ trả vị thế của agent đó', async () => {
  await repos.trading.upsertPosition('a1',
    { symbol: 'HOSE:FPT', qtyTotal: 1000, qtySellable: 0, avgCostVnd: 100_000,
      exitPlan: { takeProfitPct: 8 } });
  await repos.trading.upsertPosition('a2',
    { symbol: 'HOSE:FPT', qtyTotal: 500, qtySellable: 0, avgCostVnd: 100_000 });

  const r = await routes.positions({ params: { id: 'a1' }, query: {} });
  assert.equal(r.positions.length, 1);
  assert.equal(r.positions[0].qtyTotal, 1000);
  assert.equal(r.positions[0].exitPlan.takeProfitPct, 8);
});

test('GET /api/agents/:id/decisions trả nhật ký lý luận', async () => {
  await repos.trading.insertTrade('a1', {
    symbol: 'HOSE:FPT', action: 'BUY', priceVnd: 100_000, qty: 1000,
    reason: 'vượt MA20 với khối lượng lớn', confidence: 0.72,
  });
  const r = await routes.decisions({ params: { id: 'a1' }, query: { limit: '10' } });
  assert.equal(r.decisions.length, 1);
  assert.match(r.decisions[0].reason, /MA20/);
});

test('decisions của agent này không chứa gì của agent kia', async () => {
  await repos.trading.insertTrade('a2', {
    symbol: 'HOSE:FPT', action: 'BUY', priceVnd: 100_000, qty: 100,
    reason: 'bí mật của a2', confidence: 0.5,
  });
  const r = await routes.decisions({ params: { id: 'a1' }, query: {} });
  assert.equal(JSON.stringify(r).includes('bí mật của a2'), false);
});

test('GET /api/agents/:id/lessons trả mảng rỗng ở Phase 4 (lessons là Phase 6)', async () => {
  const r = await routes.lessons({ params: { id: 'a1' }, query: {} });
  assert.deepEqual(r.lessons, []);
});

test('GET /api/events?since= trả sự kiện sau con trỏ', async () => {
  const a = await repos.events.appendEvent({ type: 'e1', payload: {} });
  await repos.events.appendEvent({ type: 'e2', payload: {} });
  const r = await routes.events({ query: { since: String(a.id), limit: '10' } });
  assert.deepEqual(r.events.map(e => e.type), ['e2']);
});

test('GET /api/events chặn limit quá lớn', async () => {
  for (let i = 0; i < 5; i++) await repos.events.appendEvent({ type: `e${i}`, payload: {} });
  const r = await routes.events({ query: { since: '0', limit: '999999' } });
  assert.ok(r.events.length <= 500, 'phải có trần để một lời gọi không kéo cả bảng');
});

test('tham số since không phải số thì coi như 0, không ném lỗi', async () => {
  await repos.events.appendEvent({ type: 'e1', payload: {} });
  const r = await routes.events({ query: { since: 'abc' } });
  assert.equal(r.events.length, 1);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/api/tests/routes.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/routes.js'`.

- [ ] **Step 3: Cài đặt `packages/api/src/routes.js`**

```js
const MAX_LIMIT = 500;

class HttpError extends Error {
  constructor(status, message) { super(`${status}: ${message}`); this.status = status; }
}

function intParam(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

export function createRoutes({ client, repos }) {

  async function session({ query = {} }) {
    const date = query.date ?? new Date().toISOString().slice(0, 10);
    const s = await repos.ops.getSessionState(date);
    if (!s) {
      // Không có dữ liệu thì nói thẳng là không biết. Trả 'DATA_READY' cho
      // một ngày chưa ingest là đúng loại nói dối mà cả hệ thống này tránh.
      return { date, state: 'UNKNOWN', dataCapturedAt: null, note: null };
    }
    return {
      date, state: s.state,
      dataCapturedAt: s.data_captured_at, note: s.note,
    };
  }

  async function leaderboard() {
    const { rows } = await client.query(
      `SELECT a.id, a.name, a.provider, a.model, a.initial_capital AS "initialCapital",
              s.nav, s.cash, s.market_value AS "marketValue", s.day_pnl AS "dayPnl",
              (SELECT count(*) FROM positions p
               WHERE p.agent_id = a.id AND p.closed_at IS NULL) AS "positionCount"
       FROM agents a
       LEFT JOIN LATERAL (
         SELECT nav, cash, market_value, day_pnl FROM portfolio_snapshot
         WHERE agent_id = a.id ORDER BY snap_date DESC LIMIT 1
       ) s ON TRUE
       WHERE a.active
       ORDER BY s.nav DESC NULLS LAST, a.id`);

    return {
      agents: rows.map(r => ({
        id: r.id, name: r.name, provider: r.provider, model: r.model,
        initialCapital: Number(r.initialCapital),
        nav: r.nav === null ? null : Number(r.nav),
        cash: r.cash === null ? null : Number(r.cash),
        marketValue: r.marketValue === null ? null : Number(r.marketValue),
        dayPnl: r.dayPnl === null ? null : Number(r.dayPnl),
        positionCount: Number(r.positionCount),
        totalReturnPct: r.nav === null ? null
          : Math.round(((Number(r.nav) - Number(r.initialCapital)) / Number(r.initialCapital)) * 10000) / 100,
      })),
    };
  }

  async function agent({ params }) {
    const a = await repos.agents.get(params.id);
    if (!a) throw new HttpError(404, `không có agent '${params.id}'`);
    return a;
  }

  async function positions({ params }) {
    const list = await repos.trading.getOpenPositions(params.id);
    return { agentId: params.id, positions: list };
  }

  async function decisions({ params, query = {} }) {
    const limit = intParam(query.limit, 50, MAX_LIMIT);
    return { agentId: params.id, decisions: await repos.trading.listTrades(params.id, limit) };
  }

  async function lessons({ params }) {
    // Phase 6 sẽ điền. Trả mảng rỗng để dashboard dựng sẵn ô hiển thị.
    return { agentId: params.id, lessons: [] };
  }

  async function events({ query = {} }) {
    const since = intParam(query.since, 0);
    const limit = intParam(query.limit, 200, MAX_LIMIT);
    return { events: await repos.events.getEventsSince(since, limit) };
  }

  return { session, leaderboard, agent, positions, decisions, lessons, events };
}

export { HttpError };
```

- [ ] **Step 4: Cài đặt `packages/api/src/server.js`**

```js
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  createClient, createAgentsRepo, createTradingRepo,
  createOpsRepo, createEventsRepo,
} from '@stockagents/db';
import { loadApiConfig } from './config.js';
import { createRouter } from './router.js';
import { serveStatic } from './static.js';
import { createRoutes, HttpError } from './routes.js';
import { createSseHub } from './stream/sse.js';
import { createEventListener } from './stream/listener.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

export function createServer({ config, logger = console }) {
  const client = createClient(config.readonlyUrl);
  const repos = {
    agents: createAgentsRepo(client), trading: createTradingRepo(client),
    ops: createOpsRepo(client), events: createEventsRepo(client),
  };
  const routes = createRoutes({ client, repos });
  const hub = createSseHub({ eventsRepo: repos.events });

  const router = createRouter();
  router.get('/api/session', routes.session);
  router.get('/api/leaderboard', routes.leaderboard);
  router.get('/api/events', routes.events);
  router.get('/api/agents/:id', routes.agent);
  router.get('/api/agents/:id/positions', routes.positions);
  router.get('/api/agents/:id/decisions', routes.decisions);
  router.get('/api/agents/:id/lessons', routes.lessons);

  // NOTIFY chỉ mang phong bì gọn; đọc bản đầy đủ từ event_log theo id.
  const listener = createEventListener({
    connectionString: config.readonlyUrl,
    onEnvelope: async ({ id }) => {
      const [full] = await repos.events.getEventsSince(id - 1, 1);
      if (full) hub.broadcast(full);
    },
    logger,
  });

  const server = http.createServer(async (req, res) => {
    try {
      // API chỉ đọc: mọi phương thức khác GET đều bị từ chối thẳng.
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('API này chỉ đọc — chỉ chấp nhận GET');
      }

      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

      if (config.token) {
        const given = url.searchParams.get('token') ?? req.headers['x-dashboard-token'];
        if (given !== config.token) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('thiếu hoặc sai DASHBOARD_TOKEN');
        }
      }

      if (url.pathname === '/api/stream') {
        const lastId = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0);
        return hub.attach(res, Number.isFinite(lastId) ? lastId : 0);
      }

      const match = router.resolve(url.pathname);
      if (match) {
        const body = await match.handler({
          params: match.params,
          query: Object.fromEntries(url.searchParams),
        });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(body));
      }

      if (url.pathname.startsWith('/api/')) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'không có endpoint này' }));
      }

      const file = await serveStatic(PUBLIC_DIR, url.pathname);
      res.writeHead(file.status, file.headers);
      return res.end(file.body);

    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) logger.error(`[api] ${req.url}: ${err.stack ?? err.message}`);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  });

  async function listen() {
    await listener.start();
    await new Promise(resolve => server.listen(config.port, config.host, resolve));
    logger.info(`[api] dashboard tại http://${config.host}:${config.port}`);
  }

  async function close() {
    hub.stop();
    await listener.stop();
    await new Promise(resolve => server.close(resolve));
    await client.close();
  }

  return { listen, close, server, hub };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const config = loadApiConfig();
  const app = createServer({ config });
  await app.listen();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => { await app.close(); process.exit(0); });
  }
}
```

- [ ] **Step 5: Thêm script vào root `package.json`**

```json
    "api": "node packages/api/src/server.js",
```

- [ ] **Step 6: Chạy test hai lần và toàn suite**

```bash
node --test packages/api/tests/routes.test.js
node --test packages/api/tests/routes.test.js
npm test
```

Kỳ vọng: 13/13 cả hai lần; toàn suite xanh.

- [ ] **Step 7: Commit**

```bash
git add packages/api package.json
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(api): read-only routes and http server with SSE endpoint"
```

---

### Task 5: Giao diện dashboard

**Files:**
- Create: `packages/api/public/index.html`
- Create: `packages/api/public/style.css`
- Create: `packages/api/public/app.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: 8 endpoint từ Task 4
- Produces: trang một-file-một-việc, không build step, không dependency frontend

**Trước khi viết giao diện:** đọc skill `frontend-design` để định hướng thẩm mỹ. Đây là UI mới, không phải sửa vặt.

Ba vùng theo spec §11.3:
- Header: trạng thái phiên, đồng hồ, độ tươi dữ liệu (ô này đỏ khi `DATA_STALE`)
- Bảng xếp hạng: thẻ agent, nhấn để mở chi tiết bên dưới
- Dòng sự kiện: bên phải, mới nhất trên cùng, giới hạn 200 mục trong DOM

Yêu cầu bắt buộc:
- Nạp lịch sử qua `/api/events?since=0` **trước**, rồi mở SSE từ `id` lớn nhất đã nhận — không được có khoảng trống.
- Lãi/lỗ dùng cả màu **và** ký hiệu ▲▼, không phụ thuộc riêng màu sắc.
- Số tiền định dạng `toLocaleString('vi-VN')`.
- Lựa chọn agent lưu ở `localStorage` để F5 không mất.
- Vị thế hiển thị thanh tiến độ trực quan giữa `stopLossPct` và `takeProfitPct`.

- [ ] **Step 1: Đọc skill frontend-design**

```
Skill: frontend-design
```

- [ ] **Step 2: Viết `index.html`, `style.css`, `app.js`**

Theo định hướng skill và các yêu cầu bắt buộc ở trên.

- [ ] **Step 3: Kiểm chứng thủ công**

```bash
npm run api
```

Mở `http://127.0.0.1:8080`. Kỳ vọng: trang hiện bảng xếp hạng và dòng sự kiện. Ở tab khác chạy `npm run sim:day -- --agent claude_value --date <ngày> --stub` và xác nhận sự kiện **hiện lên ngay** mà không cần F5.

- [ ] **Step 4: Kiểm chứng phát lại không khoảng trống**

Ngắt mạng trình duyệt (DevTools → Network → Offline) vài giây trong lúc phiên chạy, rồi bật lại. Kỳ vọng: các sự kiện xảy ra trong lúc mất mạng **vẫn xuất hiện** sau khi nối lại.

- [ ] **Step 5: Cập nhật README và commit**

```bash
git add packages/api README.md
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(api): realtime dashboard UI"
```

---

## Điều kiện hoàn thành Phase 4

- [ ] `npm test` xanh (Phase 1–3: 266 test + Phase 4: ~38 test mới)
- [ ] Mỗi file test mới chạy riêng được và chạy hai lần liên tiếp vẫn xanh
- [ ] **Role `stockagents_ro` không ghi được** — có test chứng minh `INSERT`/`UPDATE`/`DELETE` đều bị từ chối
- [ ] Mọi phương thức khác `GET` trả 405
- [ ] Path traversal bị chặn (`/../../.env` không đọc được)
- [ ] `DASHBOARD_HOST` khác localhost mà thiếu token → server từ chối khởi động
- [ ] Mở trình duyệt thấy sự kiện hiện realtime khi chạy `sim:day` ở tab khác
- [ ] Mất mạng rồi nối lại → sự kiện bỏ lỡ vẫn tới đủ

## Ghi chú cho Phase 5

- `routes.lessons` đang trả mảng rỗng — Phase 6 nối vào bảng `lessons`.
- Dashboard chưa có biểu đồ NAV theo thời gian; `portfolio_snapshot` đã đủ dữ liệu để vẽ.
- `trade_outcomes` vẫn chưa được ghi nên chưa hiển thị được win rate.
