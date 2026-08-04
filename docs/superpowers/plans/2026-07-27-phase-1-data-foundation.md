# Phase 1 — Data Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng nền dữ liệu — PostgreSQL schema đầy đủ, repository layer có cưỡng chế cô lập theo `agent_id`, và `data-service` tự động ingest giá + chỉ báo của ~30 mã vào DB mỗi sáng qua TradingView CDP.

**Architecture:** Monorepo npm workspaces. `packages/db` sở hữu schema và mọi truy cập SQL. `packages/data-service` là tiến trình **duy nhất** được import `tradingview-mcp` — mọi lời gọi CDP đi qua một broker tuần tự hóa bằng promise-chain mutex. Ingest là idempotent (`ON CONFLICT DO UPDATE`), lỗi một mã không chặn cả batch. Sự kiện ghi vào `event_log` kèm `pg_notify` trong cùng một câu lệnh SQL để không bao giờ lệch.

**Tech Stack:** Node.js 20 (ESM), PostgreSQL 18 (pgvector hoãn sang Phase 6 — xem "Chuẩn bị môi trường"), `pg`, `node-cron`, `dotenv`, `node --test` (test runner có sẵn của Node — không thêm framework).

## Global Constraints

- Ngôn ngữ: JavaScript ESM (`"type": "module"`). Không TypeScript, không build step.
- Node.js >= 20.20. Test runner: `node --test`. Không thêm jest/vitest/mocha.
- **Chỉ `packages/data-service/src/cdp/broker.js` được phép import `tradingview-mcp`.** Mọi file khác đọc DB.
- **Mọi hàm repository truy cập bảng có `agent_id` bắt buộc nhận `agentId`**; thiếu → throw. Cưỡng chế bằng `assertAgentScope()`, không bằng quy ước.
- Không sửa bất kỳ file nào trong `tradingview_mcp/`.
- Mọi lệnh ghi DB dùng tham số hóa (`$1, $2`). Không nối chuỗi SQL.
- Giờ giao dịch và ngày giao dịch tính theo múi `Asia/Ho_Chi_Minh`.
- Tiền tệ VND lưu dạng `NUMERIC(20,2)`. Không dùng `float` cho tiền.
- Commit sau mỗi task. Message theo Conventional Commits (`feat:`, `test:`, `chore:`).

---

## File Structure

| File | Trách nhiệm |
|---|---|
| `package.json` | Root workspace, scripts, engines |
| `.env.example` | Template biến môi trường |
| `config/universe.json` | Danh sách mã giao dịch |
| `packages/db/package.json` | Manifest |
| `packages/db/src/config.js` | Đọc & validate env, export object config đóng băng |
| `packages/db/src/client.js` | Pool `pg`, `query()`, `withTransaction()`, `close()` |
| `packages/db/src/migrate.js` | Chạy migration theo thứ tự, ghi `schema_migrations` |
| `packages/db/migrations/002_market.sql` | Bảng dữ liệu thị trường + vận hành |
| `packages/db/migrations/003_trading.sql` | Bảng agent, lệnh, vị thế, giao dịch |
| `packages/db/migrations/004_memory_events.sql` | `news_items`, `lessons`, `lesson_usage`, `event_log` |
| `packages/db/src/repositories/_guard.js` | `assertAgentScope()` — cưỡng chế cô lập |
| `packages/db/src/repositories/universe.js` | Đọc/ghi danh sách mã |
| `packages/db/src/repositories/market.js` | OHLCV, indicator snapshot, quote tick, độ tươi dữ liệu |
| `packages/db/src/repositories/ops.js` | `session_state`, `ingest_errors` |
| `packages/db/src/repositories/events.js` | `appendEvent()` (INSERT + NOTIFY nguyên tử), `getEventsSince()` |
| `packages/db/src/index.js` | Public API của package |
| `packages/data-service/src/cdp/broker.js` | Mutex queue + retry + health check quanh `tradingview-mcp/core` |
| `packages/data-service/src/cdp/studies.js` | Danh sách chỉ báo bắt buộc + `ensureStudies()` |
| `packages/data-service/src/collectors/prices.js` | Đổi symbol → `getOhlcv` → chuẩn hóa |
| `packages/data-service/src/collectors/indicators.js` | `getStudyValues` → parse số |
| `packages/data-service/src/collectors/quotes.js` | `getQuote` cho danh sách mã |
| `packages/data-service/src/lib/vn_time.js` | `toVnDate()`, `nowVn()`, `isTradingDay()` |
| `packages/data-service/src/jobs/ingest_prices.js` | Điều phối batch: broker + collectors + repositories + xử lý lỗi |
| `packages/data-service/src/jobs/poll_quotes.js` | Job poll giá |
| `packages/data-service/src/jobs/prune_events.js` | Cắt tỉa `event_log` |
| `packages/data-service/src/scheduler.js` | Đăng ký cron |
| `packages/data-service/src/index.js` | Entry point |
| `packages/data-service/src/cli.js` | Chạy tay từng job |
| `tests/helpers/db.js` | Tạo/reset DB test |
| `tests/helpers/fake_core.js` | Giả lập `tradingview-mcp/core` |
| `ecosystem.config.cjs` | Cấu hình PM2 |

---

## Chuẩn bị môi trường (làm một lần, trước Task 1)

Dùng PostgreSQL **18** đã cài sẵn trên máy (service `postgresql-x64-18`, cổng 5432).

```bash
PSQL="/c/Program Files/PostgreSQL/18/bin/psql.exe"
export PGPASSWORD='<mật khẩu user postgres>'

"$PSQL" -h localhost -U postgres -d postgres -c "CREATE DATABASE stockagents;"
"$PSQL" -h localhost -U postgres -d postgres -c "CREATE DATABASE stockagents_test;"
```

Kiểm tra: `"$PSQL" -h localhost -U postgres -d stockagents -c "SELECT version();"` phải in ra PostgreSQL 18.

### pgvector hoãn sang Phase 6 — quyết định có chủ đích

Bản PG18 trên máy **không có pgvector** và Phase 1 **không dùng đến vector**: cột `embedding` chỉ phục vụ RAG lessons ở Phase 6. Vì vậy:

- Không có migration `001_extensions.sql`. Migration đầu tiên là `002_market.sql`.
- `news_items` và `lessons` **không có cột `embedding`** ở Phase 1.
- Phase 6 sẽ thêm `005_pgvector.sql` gồm `CREATE EXTENSION vector`, hai cột `embedding VECTOR(1536)` và index ivfflat — lúc đó mới cài pgvector.

Đánh số bắt đầu từ 002 để chừa chỗ, không phải lỗi.

---

### Task 1: Workspace scaffolding + config

**Files:**
- Create: `package.json`, `.gitignore`, `.env.example`, `.env`
- Create: `packages/db/package.json`, `packages/db/src/config.js`
- Test: `packages/db/tests/config.test.js`

**Interfaces:**
- Consumes: (không có — task đầu tiên)
- Produces: `config` — object đóng băng với các trường:
  `config.databaseUrl: string`, `config.databaseUrlTest: string`,
  `config.dataStalenessMinutes: number`, `config.eventLogRetentionDays: number`,
  `config.tz: 'Asia/Ho_Chi_Minh'`.
  Hàm `loadConfig(env = process.env)` → object trên; throw `Error` nếu thiếu biến bắt buộc.

- [ ] **Step 1: Khởi tạo git repo ở thư mục gốc**

Thư mục gốc `d:\MyData\StockAgents` hiện **không phải** git repo (chỉ `tradingview_mcp/` là). Khởi tạo:

```bash
cd /d/MyData/StockAgents
git init
git add docs/
git commit -m "chore: init repo with design docs"
```

- [ ] **Step 2: Tạo `.gitignore`**

```gitignore
node_modules/
.env
*.log
logs/
coverage/
tradingview_mcp/
```

> `tradingview_mcp/` bị loại vì nó đã là repo git riêng — không nhúng submodule ở phase này.

- [ ] **Step 3: Tạo `package.json` gốc**

```json
{
  "name": "stockagents",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.20.0" },
  "workspaces": ["packages/*"],
  "scripts": {
    "migrate": "node packages/db/src/migrate.js",
    "test": "node --test --test-concurrency=1 packages/",
    "data-service": "node packages/data-service/src/index.js",
    "ingest:prices": "node packages/data-service/src/cli.js ingest-prices",
    "poll:quotes": "node packages/data-service/src/cli.js poll-quotes"
  },
  "dependencies": {
    "dotenv": "^16.6.1",
    "node-cron": "^4.2.1",
    "pg": "^8.13.1"
  }
}
```

> `--test-concurrency=1` bắt buộc: các test dùng chung một DB test, chạy song song sẽ giẫm lên nhau.
>
> Truyền **thư mục** `packages/` chứ không phải glob `"packages/**/tests/*.test.js"`: Node 20 chưa hỗ trợ glob trong tham số của `node --test` — nó sẽ khớp 0 file và **thoát với mã 0**, tức là suite rỗng báo xanh. Node tự tìm đệ quy các file `*.test.js` bên dưới thư mục.

- [ ] **Step 4: Tạo `.env.example` và `.env`**

```env
DATABASE_URL=postgres://postgres:devpass@localhost:5432/stockagents
DATABASE_URL_TEST=postgres://postgres:devpass@localhost:5432/stockagents_test

DATA_STALENESS_MINUTES=90
EVENT_LOG_RETENTION_DAYS=90
```

```bash
cp .env.example .env
```

- [ ] **Step 5: Tạo `packages/db/package.json`**

```json
{
  "name": "@stockagents/db",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.js",
  "exports": { ".": "./src/index.js" }
}
```

- [ ] **Step 6: Viết test thất bại**

`packages/db/tests/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const BASE = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  DATABASE_URL_TEST: 'postgres://u:p@localhost:5432/db_test',
};

test('loadConfig đọc được các biến bắt buộc', () => {
  const cfg = loadConfig(BASE);
  assert.equal(cfg.databaseUrl, 'postgres://u:p@localhost:5432/db');
  assert.equal(cfg.tz, 'Asia/Ho_Chi_Minh');
});

test('loadConfig áp dụng giá trị mặc định cho biến tùy chọn', () => {
  const cfg = loadConfig(BASE);
  assert.equal(cfg.dataStalenessMinutes, 90);
  assert.equal(cfg.eventLogRetentionDays, 90);
});

test('loadConfig đọc được giá trị ghi đè dạng số', () => {
  const cfg = loadConfig({ ...BASE, DATA_STALENESS_MINUTES: '45' });
  assert.equal(cfg.dataStalenessMinutes, 45);
});

test('loadConfig báo lỗi rõ ràng khi thiếu DATABASE_URL', () => {
  assert.throws(
    () => loadConfig({ DATABASE_URL_TEST: BASE.DATABASE_URL_TEST }),
    /DATABASE_URL/,
  );
});

test('loadConfig từ chối số không hợp lệ', () => {
  assert.throws(
    () => loadConfig({ ...BASE, DATA_STALENESS_MINUTES: 'abc' }),
    /DATA_STALENESS_MINUTES/,
  );
});

test('config trả về là đóng băng', () => {
  const cfg = loadConfig(BASE);
  assert.throws(() => { cfg.databaseUrl = 'x'; }, TypeError);
});
```

- [ ] **Step 7: Chạy test, xác nhận thất bại**

```bash
npm install
node --test packages/db/tests/config.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/config.js'`.

- [ ] **Step 8: Cài đặt `packages/db/src/config.js`**

```js
import 'dotenv/config';

function required(env, key) {
  const value = env[key];
  if (!value || String(value).trim() === '') {
    throw new Error(`Thiếu biến môi trường bắt buộc: ${key}`);
  }
  return String(value).trim();
}

function numberWithDefault(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Biến môi trường ${key} phải là số, nhận được: ${raw}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  return Object.freeze({
    databaseUrl: required(env, 'DATABASE_URL'),
    databaseUrlTest: required(env, 'DATABASE_URL_TEST'),
    dataStalenessMinutes: numberWithDefault(env, 'DATA_STALENESS_MINUTES', 90),
    eventLogRetentionDays: numberWithDefault(env, 'EVENT_LOG_RETENTION_DAYS', 90),
    tz: 'Asia/Ho_Chi_Minh',
  });
}
```

- [ ] **Step 9: Chạy test, xác nhận thành công**

```bash
node --test packages/db/tests/config.test.js
```

Kỳ vọng: PASS — 6 test.

- [ ] **Step 10: Commit**

```bash
git add package.json .gitignore .env.example packages/db
git commit -m "feat(db): workspace scaffolding and config loader"
```

---

### Task 2: DB client + migration runner

**Files:**
- Create: `packages/db/src/client.js`, `packages/db/src/migrate.js`
- Create: `packages/db/migrations/002_market.sql`
- Create: `tests/helpers/db.js`
- Test: `packages/db/tests/migrate.test.js`

**Interfaces:**
- Consumes: `loadConfig()` từ Task 1.
- Produces:
  - `createClient(connectionString)` → `{ query(text, params) → Promise<{rows, rowCount}>, withTransaction(fn) → Promise<any>, close() → Promise<void> }`
  - `runMigrations(client, { dir }) → Promise<string[]>` — trả về mảng tên file vừa áp dụng (rỗng nếu đã áp dụng hết)
  - `tests/helpers/db.js`: `withTestDb() → Promise<client>` (đã migrate), `resetTables(client, names) → Promise<void>`

- [ ] **Step 1: Viết test thất bại**

`packages/db/tests/migrate.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.js';
import { runMigrations } from '../src/migrate.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
let client;

before(async () => {
  client = createClient(cfg.databaseUrlTest);
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});

after(async () => { await client.close(); });

test('runMigrations áp dụng migration và ghi lại vào schema_migrations', async () => {
  const applied = await runMigrations(client);
  assert.ok(applied.includes('002_market.sql'));

  const { rows } = await client.query('SELECT name FROM schema_migrations ORDER BY name');
  assert.ok(rows.some(r => r.name === '002_market.sql'));
});

test('runMigrations là idempotent — chạy lần hai không áp dụng gì thêm', async () => {
  const applied = await runMigrations(client);
  assert.deepEqual(applied, []);
});

test('DDL và ghi sổ schema_migrations là nguyên tử với nhau', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // Thân migration THÀNH CÔNG, còn lệnh ghi sổ mới là cái thất bại.
  // Chỉ có tính nguyên tử thật sự mới cứu được: nếu runMigrations không bọc
  // cả hai trong một transaction, bảng sẽ tồn tại sau khi insert lỗi.
  await client.query(
    `ALTER TABLE schema_migrations ADD CONSTRAINT tmp_reject_900
     CHECK (name NOT LIKE '900_%')`);

  try {
    const dir = await mkdtemp(join(tmpdir(), 'mig-'));
    await writeFile(join(dir, '900_atomic.sql'), 'CREATE TABLE will_not_survive (v INT);');

    await assert.rejects(runMigrations(client, { dir }), /tmp_reject_900/);

    const t = await client.query("SELECT to_regclass('public.will_not_survive') AS r");
    assert.equal(t.rows[0].r, null, 'DDL phải bị rollback cùng lệnh ghi sổ');
  } finally {
    await client.query('ALTER TABLE schema_migrations DROP CONSTRAINT tmp_reject_900');
  }
});

test('withTransaction rollback khi callback ném lỗi', async () => {
  await client.query('CREATE TABLE IF NOT EXISTS tx_probe (v INT)');
  await assert.rejects(
    client.withTransaction(async (tx) => {
      await tx.query('INSERT INTO tx_probe (v) VALUES (1)');
      throw new Error('bùm');
    }),
    /bùm/,
  );
  const { rows } = await client.query('SELECT * FROM tx_probe');
  assert.equal(rows.length, 0);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/db/tests/migrate.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/client.js'`.

- [ ] **Step 3: Cài đặt `packages/db/src/client.js`**

```js
import pg from 'pg';

const { Pool } = pg;

// Postgres trả NUMERIC dạng string để không mất độ chính xác.
// Ta giữ nguyên hành vi đó cho tiền tệ, nhưng ép BIGINT (int8) về Number
// vì id sự kiện luôn nằm trong khoảng an toàn của JS.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

// oid 1082 = DATE. Mặc định node-pg dựng Date object từ NGÀY GIỜ ĐỊA PHƯƠNG
// của máy chạy Node. Trên máy UTC+7 (Asia/Ho_Chi_Minh), '2026-07-21' thành
// Date lúc 00:00 giờ VN = 17:00 UTC ngày 20 — gọi .toISOString() sẽ ra
// '2026-07-20', LÙI MỘT NGÀY. Ép DATE trả nguyên chuỗi 'YYYY-MM-DD'.
// Phải đặt ở đây, không phải trong repository: setTypeParser là mutation
// toàn cục của module pg, đặt trong repository thì tính đúng đắn phụ thuộc
// vào việc module đó có tình cờ được import trước hay không.
pg.types.setTypeParser(1082, (v) => v);

export function createClient(connectionString) {
  const pool = new Pool({ connectionString, max: 10 });

  async function query(text, params) {
    return pool.query(text, params);
  }

  async function withTransaction(fn) {
    const conn = await pool.connect();
    try {
      await conn.query('BEGIN');
      const result = await fn({ query: (t, p) => conn.query(t, p) });
      await conn.query('COMMIT');
      return result;
    } catch (err) {
      // ROLLBACK có thể tự ném lỗi (mất kết nối, transaction đã abort).
      // Nuốt lỗi đó và luôn ném lại lỗi GỐC — nếu không, người debug sẽ
      // thấy "connection terminated" thay vì vi phạm ràng buộc thật sự.
      try {
        await conn.query('ROLLBACK');
      } catch (rollbackErr) {
        err.rollbackError = rollbackErr;
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  return { query, withTransaction, close: () => pool.end() };
}
```

- [ ] **Step 4: Tạo `packages/db/migrations/002_market.sql`**

Đánh số bắt đầu từ 002 — xem mục "Chuẩn bị môi trường": 001 để dành cho pgvector ở Phase 6.

```sql
CREATE TABLE universe (
  symbol   TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  sector   TEXT,
  name     TEXT,
  active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE ohlcv_daily (
  symbol     TEXT NOT NULL REFERENCES universe(symbol),
  trade_date DATE NOT NULL,
  open       NUMERIC(20,2) NOT NULL,
  high       NUMERIC(20,2) NOT NULL,
  low        NUMERIC(20,2) NOT NULL,
  close      NUMERIC(20,2) NOT NULL,
  volume     BIGINT NOT NULL,
  PRIMARY KEY (symbol, trade_date)
);
CREATE INDEX ohlcv_daily_symbol_date_idx ON ohlcv_daily (symbol, trade_date DESC);

CREATE TABLE indicator_snapshot (
  id          BIGSERIAL PRIMARY KEY,
  symbol      TEXT NOT NULL REFERENCES universe(symbol),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload     JSONB NOT NULL
);
CREATE INDEX indicator_snapshot_symbol_idx ON indicator_snapshot (symbol, captured_at DESC);

CREATE TABLE quote_tick (
  id     BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL REFERENCES universe(symbol),
  ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
  price  NUMERIC(20,2) NOT NULL,
  volume BIGINT
);
CREATE INDEX quote_tick_symbol_ts_idx ON quote_tick (symbol, ts DESC);

CREATE TABLE market_index_snapshot (
  id          BIGSERIAL PRIMARY KEY,
  index_code  TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  value       NUMERIC(20,2) NOT NULL,
  change_pct  NUMERIC(10,4)
);

CREATE TABLE session_state (
  trade_date        DATE PRIMARY KEY,
  state             TEXT NOT NULL,
  data_captured_at  TIMESTAMPTZ,
  note              TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ingest_errors (
  id          BIGSERIAL PRIMARY KEY,
  job         TEXT NOT NULL,
  symbol      TEXT,
  message     TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ingest_errors_occurred_idx ON ingest_errors (occurred_at DESC);
```

- [ ] **Step 5: Cài đặt `packages/db/src/migrate.js`**

```js
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from './client.js';
import { loadConfig } from './config.js';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function runMigrations(client, { dir = DEFAULT_DIR } = {}) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const done = new Set(rows.map(r => r.name));

  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    await client.withTransaction(async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    applied.push(file);
    console.log(`[migrate] đã áp dụng ${file}`);
  }
  if (applied.length === 0) console.log('[migrate] không có migration mới');
  return applied;
}

// Cho phép chạy trực tiếp: npm run migrate
// Dùng pathToFileURL — so sánh chuỗi thủ công sẽ sai trên Windows
// (import.meta.url là "file:///d:/..." còn argv[1] là "d:\...").
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  const target = process.argv.includes('--test') ? cfg.databaseUrlTest : cfg.databaseUrl;
  const client = createClient(target);
  runMigrations(client)
    .then(() => client.close())
    .catch(async (err) => {
      console.error('[migrate] lỗi:', err.message);
      await client.close();
      process.exit(1);
    });
}
```

- [ ] **Step 6: Tạo `tests/helpers/db.js`**

```js
import { createClient } from '../../packages/db/src/client.js';
import { runMigrations } from '../../packages/db/src/migrate.js';
import { loadConfig } from '../../packages/db/src/config.js';

export async function withTestDb() {
  const cfg = loadConfig();
  const client = createClient(cfg.databaseUrlTest);
  await runMigrations(client);
  return client;
}

export async function resetTables(client, names) {
  if (names.length === 0) return;
  await client.query(`TRUNCATE ${names.join(', ')} RESTART IDENTITY CASCADE`);
}
```

- [ ] **Step 7: Chạy test, xác nhận thành công**

```bash
node --test packages/db/tests/migrate.test.js
```

Kỳ vọng: PASS — 4 test.

- [ ] **Step 8: Commit**

```bash
git add packages/db tests/helpers/db.js
git commit -m "feat(db): pg client with transactions and migration runner"
```

---

### Task 3: Schema migrations — trading, memory, events

**Files:**
- Create: `packages/db/migrations/003_trading.sql`
- Create: `packages/db/migrations/004_memory_events.sql`
- Test: `packages/db/tests/schema.test.js`

**Interfaces:**
- Consumes: `runMigrations()` từ Task 2.
- Produces: toàn bộ bảng theo spec §9. Các tên bảng và cột dưới đây được mọi task sau sử dụng nguyên văn.

- [ ] **Step 1: Viết test thất bại**

`packages/db/tests/schema.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';

let client;
before(async () => { client = await withTestDb(); });
// Bắt buộc: file test phải tự dọn dẹp, không được dựa vào việc
// migrate.test.js tình cờ chạy trước và DROP SCHEMA. Thứ tự file là
// alphabet — đổi tên file hoặc chạy riêng một file sẽ phá vỡ ngay.
beforeEach(async () => {
  await resetTables(client, ['positions', 'ohlcv_daily', 'agents', 'universe']);
});
after(async () => { await client.close(); });

const EXPECTED_TABLES = [
  'universe', 'ohlcv_daily', 'indicator_snapshot', 'quote_tick',
  'market_index_snapshot', 'session_state', 'ingest_errors',
  'agents', 'orders', 'fills', 'positions', 'position_lots',
  'trades', 'trade_outcomes', 'portfolio_snapshot', 'metrics_daily',
  'news_items', 'lessons', 'lesson_usage', 'event_log',
];

test('mọi bảng theo spec đều tồn tại', async () => {
  const { rows } = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  const actual = new Set(rows.map(r => r.tablename));
  const missing = EXPECTED_TABLES.filter(t => !actual.has(t));
  assert.deepEqual(missing, [], `thiếu bảng: ${missing.join(', ')}`);
});

test('ohlcv_daily chặn trùng (symbol, trade_date)', async () => {
  await client.query(`INSERT INTO universe (symbol, exchange, name)
                      VALUES ('HOSE:FPT', 'HOSE', 'FPT Corp')
                      ON CONFLICT DO NOTHING`);
  await client.query(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume)
                      VALUES ('HOSE:FPT', '2026-07-20', 100, 110, 99, 108, 1000)`);
  await assert.rejects(
    client.query(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume)
                  VALUES ('HOSE:FPT', '2026-07-20', 1, 1, 1, 1, 1)`),
    /duplicate key/,
  );
});

test('mọi bảng thuộc về agent đều có agent_id NOT NULL', async () => {
  const agentTables = ['orders', 'positions', 'trades', 'lessons',
                       'portfolio_snapshot', 'metrics_daily'];
  const { rows } = await client.query(`
    SELECT table_name, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'agent_id'
      AND table_name = ANY($1)`, [agentTables]);
  assert.equal(rows.length, agentTables.length, 'có bảng thiếu cột agent_id');
  const nullable = rows.filter(r => r.is_nullable === 'YES').map(r => r.table_name);
  assert.deepEqual(nullable, [], `agent_id cho phép NULL ở: ${nullable.join(', ')}`);
});

test('positions chặn hai vị thế mở cùng mã cho cùng agent', async () => {
  await client.query(`INSERT INTO agents (id, name, provider, model, persona_prompt, initial_capital)
                      VALUES ('t1', 'Test', 'anthropic', 'claude-opus-5', 'p', 1000000000)
                      ON CONFLICT DO NOTHING`);
  await client.query(`INSERT INTO positions (agent_id, symbol, qty_total, qty_sellable, avg_cost)
                      VALUES ('t1', 'HOSE:FPT', 100, 0, 100)`);
  await assert.rejects(
    client.query(`INSERT INTO positions (agent_id, symbol, qty_total, qty_sellable, avg_cost)
                  VALUES ('t1', 'HOSE:FPT', 200, 0, 100)`),
    /duplicate key/,
  );
});

test('event_log có id tăng dần dùng làm con trỏ SSE', async () => {
  const a = await client.query(
    `INSERT INTO event_log (type, payload) VALUES ('a', '{}') RETURNING id`);
  const b = await client.query(
    `INSERT INTO event_log (type, payload) VALUES ('b', '{}') RETURNING id`);
  assert.ok(b.rows[0].id > a.rows[0].id);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/db/tests/schema.test.js
```

Kỳ vọng: FAIL — `thiếu bảng: universe, ohlcv_daily, ...`.

- [ ] **Step 3: Tạo `packages/db/migrations/003_trading.sql`**

```sql
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  persona_prompt  TEXT NOT NULL,
  initial_capital NUMERIC(20,2) NOT NULL,
  risk_config     JSONB NOT NULL DEFAULT '{}',
  active          BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE orders (
  id            BIGSERIAL PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  symbol        TEXT NOT NULL REFERENCES universe(symbol),
  side          TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  qty           INTEGER NOT NULL CHECK (qty > 0),
  order_type    TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT', 'ATC')),
  limit_price   NUMERIC(20,2),
  status        TEXT NOT NULL CHECK (status IN ('PENDING', 'FILLED', 'REJECTED', 'CANCELLED')),
  reject_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_agent_idx ON orders (agent_id, created_at DESC);

CREATE TABLE fills (
  id        BIGSERIAL PRIMARY KEY,
  order_id  BIGINT NOT NULL REFERENCES orders(id),
  qty       INTEGER NOT NULL CHECK (qty > 0),
  price     NUMERIC(20,2) NOT NULL,
  fee       NUMERIC(20,2) NOT NULL DEFAULT 0,
  tax       NUMERIC(20,2) NOT NULL DEFAULT 0,
  filled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE positions (
  id           BIGSERIAL PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  symbol       TEXT NOT NULL REFERENCES universe(symbol),
  qty_total    INTEGER NOT NULL,
  qty_sellable INTEGER NOT NULL DEFAULT 0,
  avg_cost     NUMERIC(20,2) NOT NULL,
  exit_plan    JSONB NOT NULL DEFAULT '{}',
  peak_price   NUMERIC(20,2),
  opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX positions_open_unique
  ON positions (agent_id, symbol) WHERE closed_at IS NULL;

CREATE TABLE position_lots (
  id            BIGSERIAL PRIMARY KEY,
  position_id   BIGINT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  qty           INTEGER NOT NULL CHECK (qty > 0),
  cost          NUMERIC(20,2) NOT NULL,
  sellable_from DATE NOT NULL
);

CREATE TABLE trades (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  symbol      TEXT NOT NULL REFERENCES universe(symbol),
  action      TEXT NOT NULL CHECK (action IN ('BUY', 'SELL')),
  price       NUMERIC(20,2) NOT NULL,
  qty         INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  -- NUMERIC(4,3) chỉ ràng buộc độ chính xác, KHÔNG ràng buộc miền giá trị:
  -- nó chấp nhận cả -9.999 lẫn 9.999. Phải có CHECK thì biên 0..1 mới thật.
  -- NULL vẫn hợp lệ ("agent không nêu độ tin cậy") vì CHECK bỏ qua NULL.
  confidence  NUMERIC(4,3) CHECK (confidence BETWEEN 0 AND 1),
  trigger     TEXT,
  context_ref JSONB NOT NULL DEFAULT '{}',
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trades_agent_idx ON trades (agent_id, decided_at DESC);

CREATE TABLE trade_outcomes (
  trade_id      BIGINT PRIMARY KEY REFERENCES trades(id),
  exit_trade_id BIGINT REFERENCES trades(id),
  pnl           NUMERIC(20,2) NOT NULL,
  pnl_pct       NUMERIC(10,4) NOT NULL,
  holding_days  INTEGER NOT NULL
);

CREATE TABLE portfolio_snapshot (
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  snap_date    DATE NOT NULL,
  cash         NUMERIC(20,2) NOT NULL,
  market_value NUMERIC(20,2) NOT NULL,
  nav          NUMERIC(20,2) NOT NULL,
  day_pnl      NUMERIC(20,2) NOT NULL,
  PRIMARY KEY (agent_id, snap_date)
);

CREATE TABLE metrics_daily (
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  snap_date         DATE NOT NULL,
  total_return_pct  NUMERIC(10,4),
  win_rate          NUMERIC(6,4) CHECK (win_rate BETWEEN 0 AND 1),
  sharpe            NUMERIC(10,4),
  max_drawdown      NUMERIC(10,4),
  avg_holding_days  NUMERIC(10,2),
  trade_count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, snap_date)
);
```

- [ ] **Step 4: Tạo `packages/db/migrations/004_memory_events.sql`**

Cột `embedding` **cố ý vắng mặt** — xem mục "Chuẩn bị môi trường". Phase 6 thêm qua `005_pgvector.sql`.

```sql
CREATE TABLE news_items (
  id           BIGSERIAL PRIMARY KEY,
  symbol       TEXT REFERENCES universe(symbol),
  source       TEXT NOT NULL,
  url          TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  summary      TEXT,
  sentiment    NUMERIC(4,3) CHECK (sentiment BETWEEN -1 AND 1),
  published_at TIMESTAMPTZ
);
CREATE INDEX news_items_symbol_idx ON news_items (symbol, published_at DESC);

CREATE TABLE lessons (
  id                 BIGSERIAL PRIMARY KEY,
  agent_id           TEXT NOT NULL REFERENCES agents(id),
  lesson             TEXT NOT NULL,
  confidence         NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  times_retrieved    INTEGER NOT NULL DEFAULT 0,
  times_helped       INTEGER NOT NULL DEFAULT 0,
  evidence_trade_ids BIGINT[] NOT NULL DEFAULT '{}',
  retired            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX lessons_agent_idx ON lessons (agent_id) WHERE retired = FALSE;

CREATE TABLE lesson_usage (
  id        BIGSERIAL PRIMARY KEY,
  lesson_id BIGINT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  trade_id  BIGINT NOT NULL REFERENCES trades(id),
  outcome   TEXT
);

CREATE TABLE event_log (
  id       BIGSERIAL PRIMARY KEY,
  ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
  type     TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  symbol   TEXT,
  payload  JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX event_log_ts_idx ON event_log (ts DESC);
```

- [ ] **Step 5: Chạy test, xác nhận thành công**

```bash
node --test packages/db/tests/schema.test.js
```

Kỳ vọng: PASS — 5 test.

- [ ] **Step 6: Áp dụng lên DB chính**

```bash
npm run migrate
```

Kỳ vọng: in ra 3 dòng `[migrate] đã áp dụng ...`.

- [ ] **Step 7: Commit**

```bash
git add packages/db/migrations packages/db/tests/schema.test.js
git commit -m "feat(db): trading, memory and event schema migrations"
```

---

### Task 4: Agent-scope guard + events repository

**Files:**
- Create: `packages/db/src/repositories/_guard.js`
- Create: `packages/db/src/repositories/events.js`
- Test: `packages/db/tests/events.test.js`

**Interfaces:**
- Consumes: `createClient()` từ Task 2; bảng `event_log` từ Task 3.
- Produces:
  - `assertAgentScope(agentId, fnName)` → `string` — trả về `agentId` đã trim; throw `Error` nếu falsy/không phải string.
  - `createEventsRepo(client)` → `{ appendEvent({type, agentId, symbol, payload}) → Promise<{id, ts}>, getEventsSince(sinceId, limit) → Promise<Event[]>, pruneOlderThan(days) → Promise<number> }`
  - `Event = { id: number, ts: Date, type: string, agentId: string|null, symbol: string|null, payload: object }`
  - Kênh NOTIFY: `agent_events`, payload là JSON `{ id, type, agentId }`.

- [ ] **Step 1: Viết test thất bại**

`packages/db/tests/events.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { loadConfig } from '../src/config.js';
import { createEventsRepo } from '../src/repositories/events.js';
import { assertAgentScope } from '../src/repositories/_guard.js';

let client, repo;

before(async () => {
  client = await withTestDb();
  repo = createEventsRepo(client);
});
beforeEach(async () => { await resetTables(client, ['event_log']); });
after(async () => { await client.close(); });

test('assertAgentScope trả về id khi hợp lệ', () => {
  assert.equal(assertAgentScope(' claude_value ', 'getLessons'), 'claude_value');
});

test('assertAgentScope ném lỗi nêu tên hàm khi thiếu agentId', () => {
  assert.throws(() => assertAgentScope(undefined, 'getLessons'), /getLessons.*agentId/s);
  assert.throws(() => assertAgentScope('', 'getLessons'), /agentId/);
  assert.throws(() => assertAgentScope(123, 'getLessons'), /agentId/);
});

test('appendEvent lưu sự kiện và trả về id tăng dần', async () => {
  const a = await repo.appendEvent({ type: 'data.ingested', payload: { job: 'prices' } });
  const b = await repo.appendEvent({ type: 'session.state', payload: { state: 'OPEN' } });
  assert.ok(b.id > a.id);
  assert.ok(a.ts instanceof Date);
});

test('appendEvent phát NOTIFY trên kênh agent_events với phong bì gọn', async () => {
  const cfg = loadConfig();
  const listener = new pg.Client({ connectionString: cfg.databaseUrlTest });
  await listener.connect();
  await listener.query('LISTEN agent_events');

  const received = new Promise((resolve) => {
    listener.on('notification', (msg) => resolve(JSON.parse(msg.payload)));
  });

  const { id } = await repo.appendEvent({
    type: 'agent.decided',
    agentId: null,
    payload: { decisions: [] },
  });

  const envelope = await received;
  assert.equal(envelope.id, id);
  assert.equal(envelope.type, 'agent.decided');
  assert.equal(envelope.agentId, null);
  // Phong bì phải nhỏ hơn nhiều so với giới hạn 8000 byte của NOTIFY
  assert.ok(JSON.stringify(envelope).length < 200);

  await listener.end();
});

test('getEventsSince trả về sự kiện có id lớn hơn con trỏ, theo thứ tự tăng', async () => {
  const first = await repo.appendEvent({ type: 'e1', payload: {} });
  await repo.appendEvent({ type: 'e2', payload: {} });
  await repo.appendEvent({ type: 'e3', payload: {} });

  const rows = await repo.getEventsSince(first.id, 10);
  assert.deepEqual(rows.map(r => r.type), ['e2', 'e3']);
  assert.deepEqual(rows[0].payload, {});
});

test('getEventsSince tôn trọng limit', async () => {
  for (let i = 0; i < 5; i++) await repo.appendEvent({ type: `e${i}`, payload: {} });
  const rows = await repo.getEventsSince(0, 2);
  assert.equal(rows.length, 2);
});

test('pruneOlderThan xóa sự kiện cũ và giữ sự kiện mới', async () => {
  await client.query(
    `INSERT INTO event_log (ts, type, payload) VALUES (now() - interval '100 days', 'old', '{}')`);
  await repo.appendEvent({ type: 'new', payload: {} });

  const deleted = await repo.pruneOlderThan(90);
  assert.equal(deleted, 1);

  const { rows } = await client.query('SELECT type FROM event_log');
  assert.deepEqual(rows.map(r => r.type), ['new']);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/db/tests/events.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/repositories/events.js'`.

- [ ] **Step 3: Cài đặt `packages/db/src/repositories/_guard.js`**

```js
/**
 * Cưỡng chế nguyên tắc cô lập agent (spec §3.2).
 * Mọi hàm repository chạm bảng có agent_id PHẢI gọi hàm này trước tiên.
 * Cô lập bằng quy ước sẽ bị phá vỡ âm thầm; cô lập bằng code thì không.
 */
export function assertAgentScope(agentId, fnName) {
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw new Error(
      `${fnName}: agentId là bắt buộc và phải là chuỗi không rỗng. ` +
      `Truy vấn dữ liệu agent mà không giới hạn phạm vi sẽ làm rò rỉ giữa các agent.`,
    );
  }
  return agentId.trim();
}
```

- [ ] **Step 4: Cài đặt `packages/db/src/repositories/events.js`**

```js
const NOTIFY_CHANNEL = 'agent_events';

function toEvent(row) {
  return {
    id: row.id,
    ts: row.ts,
    type: row.type,
    agentId: row.agent_id,
    symbol: row.symbol,
    payload: row.payload,
  };
}

export function createEventsRepo(client) {
  /**
   * Ghi event_log và phát NOTIFY trong CÙNG một câu lệnh.
   * Nguyên tử: không bao giờ có sự kiện đã ghi mà chưa báo, hoặc ngược lại.
   * Phong bì NOTIFY cố ý gọn — giới hạn của Postgres là 8000 byte,
   * còn payload đầy đủ thì consumer đọc lại từ event_log theo id.
   */
  async function appendEvent({ type, agentId = null, symbol = null, payload = {} }) {
    if (!type) throw new Error('appendEvent: type là bắt buộc');
    const { rows } = await client.query(
      `WITH ins AS (
         INSERT INTO event_log (type, agent_id, symbol, payload)
         VALUES ($1, $2, $3, $4)
         RETURNING id, ts, type, agent_id
       )
       SELECT ins.id, ins.ts,
              pg_notify($5, json_build_object(
                'id', ins.id, 'type', ins.type, 'agentId', ins.agent_id
              )::text)
       FROM ins`,
      [type, agentId, symbol, payload, NOTIFY_CHANNEL],
    );
    return { id: rows[0].id, ts: rows[0].ts };
  }

  async function getEventsSince(sinceId = 0, limit = 200) {
    const { rows } = await client.query(
      `SELECT id, ts, type, agent_id, symbol, payload
       FROM event_log WHERE id > $1 ORDER BY id ASC LIMIT $2`,
      [sinceId, limit],
    );
    return rows.map(toEvent);
  }

  async function pruneOlderThan(days) {
    const { rowCount } = await client.query(
      `DELETE FROM event_log WHERE ts < now() - ($1 || ' days')::interval`,
      [String(days)],
    );
    return rowCount;
  }

  return { appendEvent, getEventsSince, pruneOlderThan };
}
```

- [ ] **Step 5: Chạy test, xác nhận thành công**

```bash
node --test packages/db/tests/events.test.js
```

Kỳ vọng: PASS — 7 test.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories packages/db/tests/events.test.js
git commit -m "feat(db): agent scope guard and event repository with atomic notify"
```

---

### Task 5: Universe, market và ops repositories

**Files:**
- Create: `packages/db/src/repositories/universe.js`
- Create: `packages/db/src/repositories/market.js`
- Create: `packages/db/src/repositories/ops.js`
- Create: `packages/db/src/index.js`
- Create: `config/universe.json`
- Test: `packages/db/tests/market.test.js`

**Interfaces:**
- Consumes: `createClient()` (Task 2), bảng từ Task 3.
- Produces:
  - `createUniverseRepo(client)` → `{ listActive() → Promise<Symbol[]>, upsertMany(symbols) → Promise<number> }`
    với `Symbol = { symbol, exchange, sector, name, active }`
  - `createMarketRepo(client)` → `{ upsertOhlcvBars(symbol, bars) → Promise<number>, insertIndicatorSnapshot(symbol, payload) → Promise<{id}>, insertQuoteTicks(ticks) → Promise<number>, getLatestIndicatorAgeMinutes() → Promise<number|null>, getLatestBar(symbol) → Promise<Bar|null> }`
    với `Bar = { tradeDate: string 'YYYY-MM-DD', open, high, low, close, volume }` (số dạng `number`)
  - `createOpsRepo(client)` → `{ setSessionState(tradeDate, state, {dataCapturedAt, note}) → Promise<void>, getSessionState(tradeDate) → Promise<object|null>, logIngestError(job, symbol, message) → Promise<void>, countIngestErrorsSince(since) → Promise<number> }`
  - `packages/db/src/index.js` re-export: `createClient, runMigrations, loadConfig, createUniverseRepo, createMarketRepo, createOpsRepo, createEventsRepo, assertAgentScope`

- [ ] **Step 1: Viết test thất bại**

`packages/db/tests/market.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createUniverseRepo } from '../src/repositories/universe.js';
import { createMarketRepo } from '../src/repositories/market.js';
import { createOpsRepo } from '../src/repositories/ops.js';

let client, universe, market, ops;

before(async () => {
  client = await withTestDb();
  universe = createUniverseRepo(client);
  market = createMarketRepo(client);
  ops = createOpsRepo(client);
});
beforeEach(async () => {
  await resetTables(client, ['quote_tick', 'indicator_snapshot', 'ohlcv_daily',
                             'ingest_errors', 'session_state', 'universe']);
  await universe.upsertMany([
    { symbol: 'HOSE:FPT', exchange: 'HOSE', sector: 'Công nghệ', name: 'FPT' },
    { symbol: 'HOSE:VCB', exchange: 'HOSE', sector: 'Ngân hàng', name: 'Vietcombank' },
  ]);
});
after(async () => { await client.close(); });

test('upsertMany chèn mã mới và cập nhật mã đã có', async () => {
  const list = await universe.listActive();
  assert.equal(list.length, 2);

  await universe.upsertMany([
    { symbol: 'HOSE:FPT', exchange: 'HOSE', sector: 'CNTT', name: 'FPT Corp' },
  ]);
  const after = await universe.listActive();
  assert.equal(after.length, 2, 'không được tạo thêm hàng trùng');
  assert.equal(after.find(s => s.symbol === 'HOSE:FPT').sector, 'CNTT');
});

test('listActive bỏ qua mã đã tắt', async () => {
  await client.query("UPDATE universe SET active = FALSE WHERE symbol = 'HOSE:VCB'");
  const list = await universe.listActive();
  assert.deepEqual(list.map(s => s.symbol), ['HOSE:FPT']);
});

test('upsertOhlcvBars ghi bars và trả về số dòng', async () => {
  const n = await market.upsertOhlcvBars('HOSE:FPT', [
    { tradeDate: '2026-07-20', open: 100, high: 110, low: 99, close: 108, volume: 1000 },
    { tradeDate: '2026-07-21', open: 108, high: 112, low: 107, close: 111, volume: 1200 },
  ]);
  assert.equal(n, 2);
});

test('upsertOhlcvBars là idempotent — chạy lại cập nhật thay vì lỗi', async () => {
  const bars = [{ tradeDate: '2026-07-20', open: 100, high: 110, low: 99, close: 108, volume: 1000 }];
  await market.upsertOhlcvBars('HOSE:FPT', bars);
  await market.upsertOhlcvBars('HOSE:FPT', [{ ...bars[0], close: 109, volume: 2000 }]);

  const { rows } = await client.query(
    "SELECT close, volume FROM ohlcv_daily WHERE symbol = 'HOSE:FPT'");
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].close), 109);
  assert.equal(Number(rows[0].volume), 2000);
});

test('upsertOhlcvBars với mảng rỗng trả về 0 và không lỗi', async () => {
  assert.equal(await market.upsertOhlcvBars('HOSE:FPT', []), 0);
});

test('getLatestBar trả về bar mới nhất với số dạng number', async () => {
  await market.upsertOhlcvBars('HOSE:FPT', [
    { tradeDate: '2026-07-20', open: 100, high: 110, low: 99, close: 108, volume: 1000 },
    { tradeDate: '2026-07-21', open: 108, high: 112, low: 107, close: 111, volume: 1200 },
  ]);
  const bar = await market.getLatestBar('HOSE:FPT');
  assert.equal(bar.tradeDate, '2026-07-21');
  assert.equal(bar.close, 111);
  assert.equal(typeof bar.close, 'number');
});

test('getLatestBar trả về null khi chưa có dữ liệu', async () => {
  assert.equal(await market.getLatestBar('HOSE:VCB'), null);
});

test('insertIndicatorSnapshot lưu payload JSON', async () => {
  const { id } = await market.insertIndicatorSnapshot('HOSE:FPT', { rsi14: 62.5, ma20: 105 });
  assert.ok(id > 0);
  const { rows } = await client.query('SELECT payload FROM indicator_snapshot WHERE id = $1', [id]);
  assert.equal(rows[0].payload.rsi14, 62.5);
});

test('getLatestIndicatorAgeMinutes trả về null khi chưa có snapshot', async () => {
  assert.equal(await market.getLatestIndicatorAgeMinutes(), null);
});

test('getLatestIndicatorAgeMinutes tính đúng tuổi dữ liệu', async () => {
  await client.query(
    `INSERT INTO indicator_snapshot (symbol, captured_at, payload)
     VALUES ('HOSE:FPT', now() - interval '30 minutes', '{}')`);
  const age = await market.getLatestIndicatorAgeMinutes();
  assert.ok(age >= 29 && age <= 31, `kỳ vọng ~30, nhận ${age}`);
});

test('insertQuoteTicks ghi nhiều tick trong một lần', async () => {
  const n = await market.insertQuoteTicks([
    { symbol: 'HOSE:FPT', price: 111.5, volume: 500 },
    { symbol: 'HOSE:VCB', price: 92.0, volume: 300 },
  ]);
  assert.equal(n, 2);
});

test('setSessionState ghi mới rồi ghi đè cùng ngày', async () => {
  await ops.setSessionState('2026-07-21', 'PRE_OPEN', {});
  await ops.setSessionState('2026-07-21', 'OPEN', { note: 'đã ingest xong' });

  const state = await ops.getSessionState('2026-07-21');
  assert.equal(state.state, 'OPEN');
  assert.equal(state.note, 'đã ingest xong');
});

test('logIngestError lưu lỗi và đếm được', async () => {
  await ops.logIngestError('ingest_prices', 'HOSE:FPT', 'chart chưa sẵn sàng');
  await ops.logIngestError('ingest_prices', null, 'CDP đứt kết nối');
  const n = await ops.countIngestErrorsSince(new Date(Date.now() - 60_000));
  assert.equal(n, 2);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/db/tests/market.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/repositories/universe.js'`.

- [ ] **Step 3: Cài đặt `packages/db/src/repositories/universe.js`**

```js
export function createUniverseRepo(client) {
  async function listActive() {
    const { rows } = await client.query(
      `SELECT symbol, exchange, sector, name, active
       FROM universe WHERE active = TRUE ORDER BY symbol`,
    );
    return rows;
  }

  async function upsertMany(symbols) {
    if (symbols.length === 0) return 0;
    let count = 0;
    for (const s of symbols) {
      await client.query(
        `INSERT INTO universe (symbol, exchange, sector, name, active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (symbol) DO UPDATE
           SET exchange = EXCLUDED.exchange,
               sector   = EXCLUDED.sector,
               name     = EXCLUDED.name,
               active   = TRUE`,
        [s.symbol, s.exchange, s.sector ?? null, s.name ?? null],
      );
      count++;
    }
    return count;
  }

  return { listActive, upsertMany };
}
```

- [ ] **Step 4: Cài đặt `packages/db/src/repositories/market.js`**

```js
function toBar(row) {
  return {
    // client.js đã đăng ký parser cho oid 1082 nên đây luôn là chuỗi
    // 'YYYY-MM-DD'. Không thêm nhánh dự phòng instanceof Date: nếu parser
    // bị gỡ, ta muốn vỡ to tiếng chứ không âm thầm lùi ngày.
    tradeDate: row.trade_date,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  };
}

export function createMarketRepo(client) {
  async function upsertOhlcvBars(symbol, bars) {
    if (!bars || bars.length === 0) return 0;
    return client.withTransaction(async (tx) => {
      for (const b of bars) {
        await tx.query(
          `INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (symbol, trade_date) DO UPDATE
             SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
                 close = EXCLUDED.close, volume = EXCLUDED.volume`,
          [symbol, b.tradeDate, b.open, b.high, b.low, b.close, b.volume],
        );
      }
      return bars.length;
    });
  }

  async function getLatestBar(symbol) {
    const { rows } = await client.query(
      `SELECT trade_date, open, high, low, close, volume
       FROM ohlcv_daily WHERE symbol = $1 ORDER BY trade_date DESC LIMIT 1`,
      [symbol],
    );
    return rows.length ? toBar(rows[0]) : null;
  }

  async function insertIndicatorSnapshot(symbol, payload) {
    const { rows } = await client.query(
      `INSERT INTO indicator_snapshot (symbol, payload) VALUES ($1, $2) RETURNING id`,
      [symbol, payload],
    );
    return { id: rows[0].id };
  }

  async function getLatestIndicatorAgeMinutes() {
    const { rows } = await client.query(
      `SELECT EXTRACT(EPOCH FROM (now() - MAX(captured_at))) / 60 AS age
       FROM indicator_snapshot`,
    );
    const age = rows[0]?.age;
    return age === null || age === undefined ? null : Number(age);
  }

  async function insertQuoteTicks(ticks) {
    if (!ticks || ticks.length === 0) return 0;
    return client.withTransaction(async (tx) => {
      for (const t of ticks) {
        await tx.query(
          `INSERT INTO quote_tick (symbol, price, volume) VALUES ($1, $2, $3)`,
          [t.symbol, t.price, t.volume ?? null],
        );
      }
      return ticks.length;
    });
  }

  return {
    upsertOhlcvBars, getLatestBar, insertIndicatorSnapshot,
    getLatestIndicatorAgeMinutes, insertQuoteTicks,
  };
}
```

- [ ] **Step 5: Cài đặt `packages/db/src/repositories/ops.js`**

```js
export function createOpsRepo(client) {
  async function setSessionState(tradeDate, state, { dataCapturedAt = null, note = null } = {}) {
    await client.query(
      `INSERT INTO session_state (trade_date, state, data_captured_at, note, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (trade_date) DO UPDATE
         SET state = EXCLUDED.state,
             data_captured_at = COALESCE(EXCLUDED.data_captured_at, session_state.data_captured_at),
             note = EXCLUDED.note,
             updated_at = now()`,
      [tradeDate, state, dataCapturedAt, note],
    );
  }

  async function getSessionState(tradeDate) {
    const { rows } = await client.query(
      `SELECT trade_date, state, data_captured_at, note, updated_at
       FROM session_state WHERE trade_date = $1`,
      [tradeDate],
    );
    return rows[0] ?? null;
  }

  async function logIngestError(job, symbol, message) {
    await client.query(
      `INSERT INTO ingest_errors (job, symbol, message) VALUES ($1, $2, $3)`,
      [job, symbol, String(message).slice(0, 2000)],
    );
  }

  async function countIngestErrorsSince(since) {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM ingest_errors WHERE occurred_at >= $1`,
      [since],
    );
    return rows[0].n;
  }

  return { setSessionState, getSessionState, logIngestError, countIngestErrorsSince };
}
```

- [ ] **Step 6: Cài đặt `packages/db/src/index.js`**

```js
export { createClient } from './client.js';
export { runMigrations } from './migrate.js';
export { loadConfig } from './config.js';
export { assertAgentScope } from './repositories/_guard.js';
export { createUniverseRepo } from './repositories/universe.js';
export { createMarketRepo } from './repositories/market.js';
export { createOpsRepo } from './repositories/ops.js';
export { createEventsRepo } from './repositories/events.js';
```

- [ ] **Step 7: Tạo `config/universe.json`**

Rổ VN30 làm mặc định:

```json
[
  { "symbol": "HOSE:ACB", "exchange": "HOSE", "sector": "Ngân hàng", "name": "ACB" },
  { "symbol": "HOSE:BCM", "exchange": "HOSE", "sector": "Bất động sản", "name": "Becamex IDC" },
  { "symbol": "HOSE:BID", "exchange": "HOSE", "sector": "Ngân hàng", "name": "BIDV" },
  { "symbol": "HOSE:BVH", "exchange": "HOSE", "sector": "Bảo hiểm", "name": "Bảo Việt" },
  { "symbol": "HOSE:CTG", "exchange": "HOSE", "sector": "Ngân hàng", "name": "VietinBank" },
  { "symbol": "HOSE:FPT", "exchange": "HOSE", "sector": "Công nghệ", "name": "FPT" },
  { "symbol": "HOSE:GAS", "exchange": "HOSE", "sector": "Dầu khí", "name": "PV Gas" },
  { "symbol": "HOSE:GVR", "exchange": "HOSE", "sector": "Cao su", "name": "Cao su VN" },
  { "symbol": "HOSE:HDB", "exchange": "HOSE", "sector": "Ngân hàng", "name": "HDBank" },
  { "symbol": "HOSE:HPG", "exchange": "HOSE", "sector": "Thép", "name": "Hòa Phát" },
  { "symbol": "HOSE:MBB", "exchange": "HOSE", "sector": "Ngân hàng", "name": "MB Bank" },
  { "symbol": "HOSE:MSN", "exchange": "HOSE", "sector": "Tiêu dùng", "name": "Masan" },
  { "symbol": "HOSE:MWG", "exchange": "HOSE", "sector": "Bán lẻ", "name": "Thế Giới Di Động" },
  { "symbol": "HOSE:PLX", "exchange": "HOSE", "sector": "Dầu khí", "name": "Petrolimex" },
  { "symbol": "HOSE:POW", "exchange": "HOSE", "sector": "Điện", "name": "PV Power" },
  { "symbol": "HOSE:SAB", "exchange": "HOSE", "sector": "Đồ uống", "name": "Sabeco" },
  { "symbol": "HOSE:SHB", "exchange": "HOSE", "sector": "Ngân hàng", "name": "SHB" },
  { "symbol": "HOSE:SSB", "exchange": "HOSE", "sector": "Ngân hàng", "name": "SeABank" },
  { "symbol": "HOSE:SSI", "exchange": "HOSE", "sector": "Chứng khoán", "name": "SSI" },
  { "symbol": "HOSE:STB", "exchange": "HOSE", "sector": "Ngân hàng", "name": "Sacombank" },
  { "symbol": "HOSE:TCB", "exchange": "HOSE", "sector": "Ngân hàng", "name": "Techcombank" },
  { "symbol": "HOSE:TPB", "exchange": "HOSE", "sector": "Ngân hàng", "name": "TPBank" },
  { "symbol": "HOSE:VCB", "exchange": "HOSE", "sector": "Ngân hàng", "name": "Vietcombank" },
  { "symbol": "HOSE:VHM", "exchange": "HOSE", "sector": "Bất động sản", "name": "Vinhomes" },
  { "symbol": "HOSE:VIB", "exchange": "HOSE", "sector": "Ngân hàng", "name": "VIB" },
  { "symbol": "HOSE:VIC", "exchange": "HOSE", "sector": "Bất động sản", "name": "Vingroup" },
  { "symbol": "HOSE:VJC", "exchange": "HOSE", "sector": "Hàng không", "name": "Vietjet" },
  { "symbol": "HOSE:VNM", "exchange": "HOSE", "sector": "Tiêu dùng", "name": "Vinamilk" },
  { "symbol": "HOSE:VPB", "exchange": "HOSE", "sector": "Ngân hàng", "name": "VPBank" },
  { "symbol": "HOSE:VRE", "exchange": "HOSE", "sector": "Bất động sản", "name": "Vincom Retail" }
]
```

- [ ] **Step 8: Chạy test, xác nhận thành công**

```bash
node --test packages/db/tests/market.test.js
```

Kỳ vọng: PASS — 13 test.

- [ ] **Step 9: Commit**

```bash
git add packages/db config/universe.json
git commit -m "feat(db): universe, market and ops repositories with VN30 seed"
```

---

### Task 6: CDP broker

**Files:**
- Create: `packages/data-service/package.json`
- Create: `packages/data-service/src/cdp/broker.js`
- Create: `tests/helpers/fake_core.js`
- Test: `packages/data-service/tests/broker.test.js`

**Interfaces:**
- Consumes: `tradingview-mcp/core` (chỉ ở file này).
- Produces: `createBroker({ core, logger, maxRetries, baseDelayMs, sleep }) → Broker`
  - `broker.run(fn) → Promise<T>` — chạy `fn(core)` tuần tự
  - `broker.withSymbol(symbol, fn) → Promise<T>` — `setSymbol` rồi chạy `fn(core)`, có retry
  - `broker.ensureConnected() → Promise<boolean>` — health check, tự `launch()` một lần nếu đứt
  - `broker.stats() → { queued, completed, failed }`
  - Lỗi ném ra là `BrokerError` với `.symbol` và `.attempts`

- [ ] **Step 1: Tạo `packages/data-service/package.json`**

```json
{
  "name": "@stockagents/data-service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.js",
  "dependencies": {
    "@stockagents/db": "*",
    "tradingview-mcp": "file:../../tradingview_mcp"
  }
}
```

Cài lại workspace:

```bash
npm install
```

Kiểm tra link đã đúng:

```bash
node -e "import('tradingview-mcp/core').then(m => console.log(Object.keys(m)))"
```

Kỳ vọng: in ra mảng chứa `chart`, `data`, `health`, ...

- [ ] **Step 2: Tạo `tests/helpers/fake_core.js`**

```js
/**
 * Giả lập tradingview-mcp/core cho test.
 * Ghi lại thứ tự lời gọi để kiểm chứng broker thực sự tuần tự hóa.
 */
export function createFakeCore({ failFirst = 0, delayMs = 0, healthy = true } = {}) {
  const calls = [];
  let failures = failFirst;
  let currentSymbol = null;
  let launchCount = 0;
  let healthyNow = healthy;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  return {
    calls,
    get currentSymbol() { return currentSymbol; },
    get launchCount() { return launchCount; },
    setHealthy(v) { healthyNow = v; },

    chart: {
      async setSymbol({ symbol }) {
        calls.push(`setSymbol:${symbol}`);
        if (delayMs) await sleep(delayMs);
        currentSymbol = symbol;
        return { success: true, symbol, chart_ready: true };
      },
      async setTimeframe({ timeframe }) {
        calls.push(`setTimeframe:${timeframe}`);
        return { success: true };
      },
      async getState() {
        calls.push('getState');
        return { success: true, symbol: currentSymbol, studies: [] };
      },
      async manageIndicator({ action, indicator }) {
        calls.push(`manageIndicator:${action}:${indicator}`);
        return { success: true };
      },
    },

    data: {
      async getOhlcv({ count }) {
        calls.push(`getOhlcv:${currentSymbol}:${count}`);
        if (failures > 0) { failures--; throw new Error('Could not extract OHLCV data'); }
        if (delayMs) await sleep(delayMs);
        return {
          success: true, bar_count: 2,
          // 1784592000 = 2026-07-21T00:00:00Z, 1784678400 = 2026-07-22T00:00:00Z
          bars: [
            { time: 1784592000, open: 100, high: 110, low: 99, close: 108, volume: 1000 },
            { time: 1784678400, open: 108, high: 112, low: 107, close: 111, volume: 1200 },
          ],
        };
      },
      async getStudyValues() {
        calls.push(`getStudyValues:${currentSymbol}`);
        return {
          success: true, study_count: 2,
          studies: [
            { name: 'Relative Strength Index', values: { RSI: '62.53', 'RSI-based MA': '58.10' } },
            { name: 'Moving Average Simple', values: { Plot: '105.20' } },
          ],
        };
      },
      async getQuote() {
        calls.push(`getQuote:${currentSymbol}`);
        return { success: true, price: 111.5, volume: 500 };
      },
    },

    health: {
      async healthCheck() {
        calls.push('healthCheck');
        if (!healthyNow) throw new Error('CDP not connected');
        return { success: true, cdp_connected: true, api_available: true };
      },
      async launch() {
        calls.push('launch');
        launchCount++;
        healthyNow = true;
        return { success: true };
      },
    },
  };
}
```

- [ ] **Step 3: Viết test thất bại**

`packages/data-service/tests/broker.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBroker } from '../src/cdp/broker.js';
import { createFakeCore } from '../../../tests/helpers/fake_core.js';

const silent = { info() {}, warn() {}, error() {} };
const noSleep = () => Promise.resolve();

test('withSymbol đổi symbol rồi chạy callback', async () => {
  const core = createFakeCore();
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  const result = await broker.withSymbol('HOSE:FPT', (c) => c.data.getOhlcv({ count: 60 }));

  assert.equal(result.bar_count, 2);
  assert.deepEqual(core.calls, ['setSymbol:HOSE:FPT', 'getOhlcv:HOSE:FPT:60']);
});

test('các lời gọi đồng thời bị tuần tự hóa, không đan xen', async () => {
  const core = createFakeCore({ delayMs: 20 });
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  await Promise.all([
    broker.withSymbol('HOSE:AAA', (c) => c.data.getOhlcv({ count: 10 })),
    broker.withSymbol('HOSE:BBB', (c) => c.data.getOhlcv({ count: 10 })),
    broker.withSymbol('HOSE:CCC', (c) => c.data.getOhlcv({ count: 10 })),
  ]);

  assert.deepEqual(core.calls, [
    'setSymbol:HOSE:AAA', 'getOhlcv:HOSE:AAA:10',
    'setSymbol:HOSE:BBB', 'getOhlcv:HOSE:BBB:10',
    'setSymbol:HOSE:CCC', 'getOhlcv:HOSE:CCC:10',
  ]);
});

test('withSymbol thử lại khi lỗi tạm thời rồi thành công', async () => {
  const core = createFakeCore({ failFirst: 2 });
  const broker = createBroker({ core, logger: silent, maxRetries: 3, sleep: noSleep });

  const result = await broker.withSymbol('HOSE:FPT', (c) => c.data.getOhlcv({ count: 60 }));
  assert.equal(result.bar_count, 2);
  assert.equal(core.calls.filter(c => c.startsWith('getOhlcv')).length, 3);
});

test('withSymbol ném BrokerError kèm symbol sau khi hết lượt thử', async () => {
  const core = createFakeCore({ failFirst: 99 });
  const broker = createBroker({ core, logger: silent, maxRetries: 2, sleep: noSleep });

  await assert.rejects(
    broker.withSymbol('HOSE:FPT', (c) => c.data.getOhlcv({ count: 60 })),
    (err) => {
      assert.equal(err.name, 'BrokerError');
      assert.equal(err.symbol, 'HOSE:FPT');
      assert.equal(err.attempts, 2);
      return true;
    },
  );
});

test('một mã lỗi không chặn mã kế tiếp trong hàng đợi', async () => {
  const core = createFakeCore({ failFirst: 99 });
  const broker = createBroker({ core, logger: silent, maxRetries: 1, sleep: noSleep });

  const results = await Promise.allSettled([
    broker.withSymbol('HOSE:BAD', (c) => c.data.getOhlcv({ count: 10 })),
    broker.withSymbol('HOSE:OK', (c) => c.data.getStudyValues()),
  ]);

  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
});

test('ensureConnected trả về true khi CDP khỏe', async () => {
  const core = createFakeCore();
  const broker = createBroker({ core, logger: silent, sleep: noSleep });
  assert.equal(await broker.ensureConnected(), true);
  assert.equal(core.launchCount, 0);
});

test('ensureConnected tự launch một lần khi CDP đứt', async () => {
  const core = createFakeCore({ healthy: false });
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  assert.equal(await broker.ensureConnected(), true);
  assert.equal(core.launchCount, 1);
});

test('ensureConnected trả về false khi launch cũng không cứu được', async () => {
  const core = createFakeCore({ healthy: false });
  core.health.launch = async () => { core.calls.push('launch'); throw new Error('không tìm thấy TradingView'); };

  const broker = createBroker({ core, logger: silent, sleep: noSleep });
  assert.equal(await broker.ensureConnected(), false);
});

test('stats đếm đúng số việc hoàn thành và thất bại', async () => {
  const core = createFakeCore({ failFirst: 99 });
  const broker = createBroker({ core, logger: silent, maxRetries: 1, sleep: noSleep });

  await broker.withSymbol('HOSE:OK', (c) => c.data.getStudyValues());
  await broker.withSymbol('HOSE:BAD', (c) => c.data.getOhlcv({ count: 10 })).catch(() => {});

  const s = broker.stats();
  assert.equal(s.completed, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.queued, 0);
});
```

- [ ] **Step 4: Chạy test, xác nhận thất bại**

```bash
node --test packages/data-service/tests/broker.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/cdp/broker.js'`.

- [ ] **Step 5: Cài đặt `packages/data-service/src/cdp/broker.js`**

```js
/**
 * CDP Broker — điểm truy cập DUY NHẤT tới TradingView (spec §3.1, §5.1).
 *
 * TradingView Desktop có một chart hoạt động duy nhất và `setSymbol` đổi trạng
 * thái toàn cục. Hai lời gọi song song sẽ đọc nhầm dữ liệu của nhau. Broker
 * tuần tự hóa mọi truy cập bằng promise-chain mutex.
 *
 * `core` được truyền vào (dependency injection) để test được mà không cần
 * TradingView đang chạy — `core/data.js` không hỗ trợ tham số `_deps`.
 */

export class BrokerError extends Error {
  constructor(message, { symbol, attempts, cause } = {}) {
    super(message);
    this.name = 'BrokerError';
    this.symbol = symbol ?? null;
    this.attempts = attempts ?? 0;
    this.cause = cause;
  }
}

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

export function createBroker({
  core,
  logger = console,
  maxRetries = 3,
  baseDelayMs = 500,
  sleep = defaultSleep,
} = {}) {
  if (!core) throw new Error('createBroker: cần truyền core');

  let chain = Promise.resolve();
  let queued = 0;
  let completed = 0;
  let failed = 0;

  /** Nối việc vào cuối hàng đợi. Việc lỗi không làm đứt chuỗi. */
  function enqueue(job) {
    queued++;
    const result = chain.then(job, job);
    chain = result.then(() => {}, () => {});
    return result.finally(() => { queued--; });
  }

  async function run(fn) {
    return enqueue(async () => {
      const value = await fn(core);
      completed++;
      return value;
    });
  }

  async function withSymbol(symbol, fn) {
    return enqueue(async () => {
      let lastError;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await core.chart.setSymbol({ symbol });
          const value = await fn(core);
          completed++;
          return value;
        } catch (err) {
          lastError = err;
          logger.warn(`[broker] ${symbol} lần ${attempt}/${maxRetries} lỗi: ${err.message}`);
          if (attempt < maxRetries) await sleep(baseDelayMs * 2 ** (attempt - 1));
        }
      }
      failed++;
      throw new BrokerError(
        `Bỏ qua ${symbol} sau ${maxRetries} lần thử: ${lastError.message}`,
        { symbol, attempts: maxRetries, cause: lastError },
      );
    });
  }

  async function ensureConnected() {
    try {
      await core.health.healthCheck();
      return true;
    } catch (err) {
      logger.warn(`[broker] CDP không khả dụng (${err.message}), thử launch TradingView`);
      try {
        await core.health.launch();
        await core.health.healthCheck();
        return true;
      } catch (launchErr) {
        logger.error(`[broker] launch thất bại: ${launchErr.message}`);
        return false;
      }
    }
  }

  return { run, withSymbol, ensureConnected, stats: () => ({ queued, completed, failed }) };
}
```

- [ ] **Step 6: Chạy test, xác nhận thành công**

```bash
node --test packages/data-service/tests/broker.test.js
```

Kỳ vọng: PASS — 9 test.

- [ ] **Step 7: Commit**

```bash
git add packages/data-service tests/helpers/fake_core.js
git commit -m "feat(data-service): serialized CDP broker with retry and auto-launch"
```

---

### Task 7: Collectors — giá, chỉ báo, quote

**Files:**
- Create: `packages/data-service/src/lib/vn_time.js`
- Create: `packages/data-service/src/cdp/studies.js`
- Create: `packages/data-service/src/collectors/prices.js`
- Create: `packages/data-service/src/collectors/indicators.js`
- Create: `packages/data-service/src/collectors/quotes.js`
- Test: `packages/data-service/tests/vn_time.test.js`
- Test: `packages/data-service/tests/collectors.test.js`

**Interfaces:**
- Consumes: `createBroker()` (Task 6), `createFakeCore()` (Task 6).
- Produces:
  - `toVnDate(unixSeconds) → 'YYYY-MM-DD'`
  - `nowVnDate() → 'YYYY-MM-DD'`
  - `isTradingDay(date) → boolean` (T2–T6)
  - `REQUIRED_STUDIES` → `string[]` tên đầy đủ chỉ báo
  - `ensureStudies(broker) → Promise<string[]>` — trả về danh sách chỉ báo vừa thêm
  - `collectPrices(broker, symbol, {count}) → Promise<Bar[]>` — `Bar` như Task 5
  - `collectIndicators(broker, symbol) → Promise<{raw: object[], parsed: object}>`
  - `parseStudyValues(studies) → object` — khóa chuẩn hóa: `rsi14, ma20, macd, macdSignal, macdHist, bbUpper, bbBasis, bbLower, atr14, volume`. Khóa nào không parse được thì **vắng mặt**, không phải `null`.
    > Chỉ có **một** đường MA ở Phase 1. `getStudyValues` trả về các instance cùng tên là các mục trùng `name`, không phân biệt được chu kỳ — muốn MA50/MA200 phải lấy id của study qua `chart.getState()` rồi `data.getIndicator({ entity_id })`. Lưu ý: `getState()` trả về study dạng `{ id, name }`, trường tên là **`id`** chứ không phải `entity_id` (`entity_id` chỉ xuất hiện trong kết quả `manageIndicator` khi *add*). Để lại Phase 2 khi agent thật sự cần.
  - `collectQuotes(broker, symbols) → Promise<{ticks: Tick[], errors: {symbol, message}[]}>` với `Tick = {symbol, price, volume}`

- [ ] **Step 1: Viết test thất bại cho `vn_time`**

`packages/data-service/tests/vn_time.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toVnDate, nowVnDate, isTradingDay } from '../src/lib/vn_time.js';

test('toVnDate chuyển timestamp bar hằng ngày sang ngày giao dịch VN', () => {
  // 2026-07-21T00:00:00Z — TradingView đặt bar ngày ở nửa đêm UTC
  assert.equal(toVnDate(1784592000), '2026-07-21');
});

test('toVnDate xử lý mốc sát nửa đêm UTC không bị lùi ngày', () => {
  // 2026-07-20T23:00:00Z → 2026-07-21T06:00 giờ VN
  assert.equal(toVnDate(1784588400), '2026-07-21');
});

test('toVnDate từ chối giá trị không phải số hữu hạn', () => {
  assert.throws(() => toVnDate(NaN), /toVnDate/);
  assert.throws(() => toVnDate(null), /toVnDate/);
});

test('nowVnDate trả về chuỗi đúng định dạng', () => {
  assert.match(nowVnDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test('isTradingDay đúng với T2–T6 và sai với cuối tuần', () => {
  assert.equal(isTradingDay('2026-07-20'), true);  // thứ Hai
  assert.equal(isTradingDay('2026-07-24'), true);  // thứ Sáu
  assert.equal(isTradingDay('2026-07-25'), false); // thứ Bảy
  assert.equal(isTradingDay('2026-07-26'), false); // Chủ nhật
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/data-service/tests/vn_time.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/lib/vn_time.js'`.

- [ ] **Step 3: Cài đặt `packages/data-service/src/lib/vn_time.js`**

```js
const TZ = 'Asia/Ho_Chi_Minh';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

// Cửa sổ epoch-GIÂY hợp lý: 1990-01-01 .. 2100-01-01.
// Đủ rộng cho mọi lịch sử chart, đủ hẹp để một giá trị mili-giây
// (vd Date.now()) không bao giờ lọt vào.
const MIN_TS = 631152000;
const MAX_TS = 4102444800;

/** Unix seconds → 'YYYY-MM-DD' theo giờ Việt Nam. */
export function toVnDate(unixSeconds) {
  if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds)) {
    throw new Error(`toVnDate: cần số giây hữu hạn, nhận được: ${unixSeconds}`);
  }
  // Chỉ kiểm tra hữu hạn là chưa đủ: truyền nhầm mili-giây sẽ cho ra một
  // ngày xa lắc mà KHÔNG có lỗi nào bung ra — đúng loại "ngày sai âm thầm"
  // mà kế hoạch này đã dính một lần.
  if (unixSeconds < MIN_TS || unixSeconds > MAX_TS) {
    throw new Error(
      `toVnDate: ${unixSeconds} nằm ngoài khoảng epoch-giây hợp lệ ` +
      `(${MIN_TS}..${MAX_TS}). Hàm này nhận GIÂY, không phải mili-giây.`,
    );
  }
  // en-CA cho ra định dạng ISO YYYY-MM-DD
  return dateFormatter.format(new Date(unixSeconds * 1000));
}

export function nowVnDate(now = new Date()) {
  return dateFormatter.format(now);
}

/** Thứ Hai–thứ Sáu. Chưa xét ngày lễ — bổ sung ở phase sau nếu cần. */
export function isTradingDay(isoDate) {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}
```

- [ ] **Step 4: Chạy test, xác nhận thành công**

```bash
node --test packages/data-service/tests/vn_time.test.js
```

Kỳ vọng: PASS — 5 test.

- [ ] **Step 5: Viết test thất bại cho collectors**

`packages/data-service/tests/collectors.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBroker } from '../src/cdp/broker.js';
import { createFakeCore } from '../../../tests/helpers/fake_core.js';
import { collectPrices } from '../src/collectors/prices.js';
import { collectIndicators, parseStudyValues } from '../src/collectors/indicators.js';
import { collectQuotes } from '../src/collectors/quotes.js';
import { ensureStudies, REQUIRED_STUDIES } from '../src/cdp/studies.js';

const silent = { info() {}, warn() {}, error() {} };
const noSleep = () => Promise.resolve();
const makeBroker = (opts) =>
  createBroker({ core: createFakeCore(opts), logger: silent, sleep: noSleep });

test('collectPrices trả về bars đã chuẩn hóa sang ngày giao dịch VN', async () => {
  const bars = await collectPrices(makeBroker(), 'HOSE:FPT', { count: 60 });

  assert.equal(bars.length, 2);
  assert.deepEqual(bars[0], {
    tradeDate: '2026-07-21', open: 100, high: 110, low: 99, close: 108, volume: 1000,
  });
  assert.equal(bars[1].tradeDate, '2026-07-22');
});

test('collectPrices báo lỗi khi chart trả về mảng bars rỗng', async () => {
  const core = createFakeCore();
  core.data.getOhlcv = async () => ({ success: true, bar_count: 0, bars: [] });
  const broker = createBroker({ core, logger: silent, sleep: noSleep, maxRetries: 1 });

  await assert.rejects(collectPrices(broker, 'HOSE:FPT', { count: 60 }), /không có bar/);
});

test('parseStudyValues chuyển giá trị chuỗi thành số theo khóa chuẩn', () => {
  const parsed = parseStudyValues([
    { name: 'Relative Strength Index', values: { RSI: '62.53' } },
    { name: 'Moving Average Simple', values: { Plot: '105.20' } },
    { name: 'MACD', values: { MACD: '1.25', Signal: '0.98', Histogram: '0.27' } },
    { name: 'Bollinger Bands', values: { Upper: '115.0', Basis: '105.0', Lower: '95.0' } },
    { name: 'Average True Range', values: { ATR: '2.35' } },
  ]);

  assert.equal(parsed.rsi14, 62.53);
  assert.equal(parsed.macd, 1.25);
  assert.equal(parsed.macdSignal, 0.98);
  assert.equal(parsed.macdHist, 0.27);
  assert.equal(parsed.bbUpper, 115);
  assert.equal(parsed.bbBasis, 105);
  assert.equal(parsed.bbLower, 95);
  assert.equal(parsed.atr14, 2.35);
});

test('parseStudyValues bỏ qua giá trị không phân tích được thay vì ném lỗi', () => {
  const parsed = parseStudyValues([
    { name: 'Relative Strength Index', values: { RSI: 'n/a' } },
    { name: 'Average True Range', values: { ATR: '2.35' } },
  ]);
  assert.equal(parsed.rsi14, undefined);
  assert.equal(parsed.atr14, 2.35);
});

test('parseStudyValues xử lý mảng rỗng', () => {
  assert.deepEqual(parseStudyValues([]), {});
});

test('collectIndicators trả về cả raw và parsed', async () => {
  const result = await collectIndicators(makeBroker(), 'HOSE:FPT');

  assert.equal(result.parsed.rsi14, 62.53);
  assert.equal(result.raw.length, 2);
});

test('collectQuotes gom tick và tách riêng lỗi từng mã', async () => {
  const core = createFakeCore();
  let calls = 0;
  const originalGetQuote = core.data.getQuote;
  core.data.getQuote = async function (...args) {
    calls++;
    if (calls === 2) throw new Error('quote không khả dụng');
    return originalGetQuote.apply(this, args);
  };
  const broker = createBroker({ core, logger: silent, sleep: noSleep, maxRetries: 1 });

  const { ticks, errors } = await collectQuotes(broker, ['HOSE:A', 'HOSE:B', 'HOSE:C']);

  assert.deepEqual(ticks.map(t => t.symbol), ['HOSE:A', 'HOSE:C']);
  // Giá lấy từ `last` của quote thật, không phải trường `price` (không tồn tại)
  assert.equal(ticks[0].price, 111);
  assert.ok(Number.isFinite(ticks[0].price), 'không được là NaN');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].symbol, 'HOSE:B');
});

test('collectQuotes với danh sách rỗng trả về kết quả rỗng, không chạm CDP', async () => {
  const core = createFakeCore();
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  const { ticks, errors } = await collectQuotes(broker, []);
  assert.deepEqual(ticks, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(core.calls, []);
});

test('ensureStudies thêm các chỉ báo còn thiếu và bỏ qua chỉ báo đã có', async () => {
  const core = createFakeCore();
  // Khớp shape thật của chart.getState(): study là { id, name }
  core.chart.getState = async () => ({
    success: true,
    studies: [{ id: 'x1', name: 'Relative Strength Index' }],
  });
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  const added = await ensureStudies(broker);

  assert.ok(!added.includes('Relative Strength Index'), 'không thêm lại chỉ báo đã có');
  assert.equal(added.length, REQUIRED_STUDIES.length - 1);
  assert.ok(core.calls.some(c => c === 'manageIndicator:add:Average True Range'));
});
```

- [ ] **Step 6: Chạy test, xác nhận thất bại**

```bash
node --test packages/data-service/tests/collectors.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/collectors/prices.js'`.

- [ ] **Step 7: Cài đặt `packages/data-service/src/cdp/studies.js`**

```js
/**
 * TradingView yêu cầu TÊN ĐẦY ĐỦ khi thêm chỉ báo
 * ("Relative Strength Index", không phải "RSI") — xem tradingview_mcp/CLAUDE.md.
 */
export const REQUIRED_STUDIES = [
  'Relative Strength Index',
  'Moving Average Simple',
  'MACD',
  'Bollinger Bands',
  'Average True Range',
];

/**
 * Đảm bảo mọi chỉ báo bắt buộc đang có trên chart.
 * Chart là trạng thái toàn cục nên chỉ cần chạy một lần mỗi lần khởi động
 * data-service, không phải mỗi mã.
 */
export async function ensureStudies(broker) {
  return broker.run(async (core) => {
    const state = await core.chart.getState();
    const present = new Set((state.studies || []).map(s => s.name));

    const added = [];
    for (const name of REQUIRED_STUDIES) {
      if (present.has(name)) continue;
      await core.chart.manageIndicator({ action: 'add', indicator: name });
      added.push(name);
    }
    return added;
  });
}
```

- [ ] **Step 8: Cài đặt `packages/data-service/src/collectors/prices.js`**

```js
import { toVnDate } from '../lib/vn_time.js';

/**
 * Lấy bars hằng ngày cho một mã và chuẩn hóa về hình dạng repository cần.
 * `summary` cố ý KHÔNG dùng — ta cần từng bar để lưu lịch sử.
 */
export async function collectPrices(broker, symbol, { count = 60 } = {}) {
  const result = await broker.withSymbol(symbol, (core) => core.data.getOhlcv({ count }));

  const bars = result?.bars ?? [];
  if (bars.length === 0) {
    throw new Error(`collectPrices: ${symbol} không có bar nào trả về`);
  }

  return bars.map(b => ({
    tradeDate: toVnDate(b.time),
    open: Number(b.open),
    high: Number(b.high),
    low: Number(b.low),
    close: Number(b.close),
    volume: Number(b.volume ?? 0),
  }));
}
```

- [ ] **Step 9: Cài đặt `packages/data-service/src/collectors/indicators.js`**

```js
/**
 * Ánh xạ (tên study của TradingView, tiêu đề giá trị) → khóa chuẩn hóa.
 * `getStudyValues` trả về giá trị dạng CHUỖI đã format, nên phải parse.
 */
const FIELD_MAP = [
  ['Relative Strength Index', 'RSI', 'rsi14'],
  ['Moving Average Simple', 'Plot', 'ma20'],
  ['MACD', 'MACD', 'macd'],
  ['MACD', 'Signal', 'macdSignal'],
  ['MACD', 'Histogram', 'macdHist'],
  ['Bollinger Bands', 'Upper', 'bbUpper'],
  ['Bollinger Bands', 'Basis', 'bbBasis'],
  ['Bollinger Bands', 'Lower', 'bbLower'],
  ['Average True Range', 'ATR', 'atr14'],
  ['Volume', 'Volume', 'volume'],
];

function parseNumber(raw) {
  if (raw === null || raw === undefined) return undefined;
  // Bỏ dấu phân cách nghìn và ký tự đơn vị (K/M/B TradingView đôi khi thêm vào)
  const cleaned = String(raw).replace(/,/g, '').trim();
  const multiplier = /K$/i.test(cleaned) ? 1e3
                   : /M$/i.test(cleaned) ? 1e6
                   : /B$/i.test(cleaned) ? 1e9 : 1;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value * multiplier : undefined;
}

export function parseStudyValues(studies) {
  const parsed = {};
  for (const [studyName, valueTitle, key] of FIELD_MAP) {
    const study = (studies || []).find(s => s.name === studyName);
    if (!study) continue;
    const value = parseNumber(study.values?.[valueTitle]);
    if (value !== undefined) parsed[key] = value;
  }
  return parsed;
}

export async function collectIndicators(broker, symbol) {
  const result = await broker.withSymbol(symbol, (core) => core.data.getStudyValues());
  const raw = result?.studies ?? [];
  return { raw, parsed: parseStudyValues(raw) };
}
```

- [ ] **Step 10: Cài đặt `packages/data-service/src/collectors/quotes.js`**

```js
/**
 * Poll giá cho một danh sách mã.
 * Một mã lỗi KHÔNG được làm hỏng cả batch — trả riêng mảng errors
 * để job gọi quyết định ghi log thế nào.
 */
export async function collectQuotes(broker, symbols) {
  const ticks = [];
  const errors = [];

  for (const symbol of symbols) {
    try {
      const q = await broker.withSymbol(symbol, (core) => core.data.getQuote({ symbol }));
      // core.data.getQuote KHÔNG trả trường `price`. Nó trả `last` và `close`
      // (cùng lấy từ bar cuối) và tự ném lỗi nếu thiếu cả hai — xem
      // tradingview_mcp/src/core/data.js. Đọc nhầm tên trường sẽ cho NaN
      // mà không có lỗi nào bung ra.
      const price = q.last ?? q.close;
      if (!Number.isFinite(Number(price))) {
        throw new Error(`collectQuotes: ${symbol} trả về giá không hợp lệ: ${price}`);
      }
      ticks.push({
        symbol,
        price: Number(price),
        volume: q.volume === undefined ? null : Number(q.volume),
      });
    } catch (err) {
      errors.push({ symbol, message: err.message });
    }
  }

  return { ticks, errors };
}
```

- [ ] **Step 11: Chạy test, xác nhận thành công**

```bash
node --test packages/data-service/tests/collectors.test.js packages/data-service/tests/vn_time.test.js
```

Kỳ vọng: PASS — 14 test.

- [ ] **Step 12: Commit**

```bash
git add packages/data-service/src packages/data-service/tests
git commit -m "feat(data-service): price, indicator and quote collectors with VN date handling"
```

---

### Task 8: Ingest job

**Files:**
- Create: `packages/data-service/src/jobs/ingest_prices.js`
- Create: `packages/data-service/src/jobs/poll_quotes.js`
- Create: `packages/data-service/src/jobs/prune_events.js`
- Test: `packages/data-service/tests/ingest_prices.test.js`

**Interfaces:**
- Consumes: repositories (Task 4, 5), broker (Task 6), collectors (Task 7).
- Produces:
  - `runIngestPrices({broker, repos, logger, barCount}) → Promise<Summary>`
    `Summary = { tradeDate, total, succeeded, failed, durationMs, failedSymbols: string[] }`
  - `runPollQuotes({broker, repos, symbols, logger}) → Promise<{inserted, failed}>`
  - `runPruneEvents({repos, retentionDays, logger}) → Promise<{deleted}>`
  - `repos` là object `{ universe, market, ops, events }`

- [ ] **Step 1: Viết test thất bại**

`packages/data-service/tests/ingest_prices.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createFakeCore } from '../../../tests/helpers/fake_core.js';
import { createBroker } from '../src/cdp/broker.js';
import { runIngestPrices } from '../src/jobs/ingest_prices.js';
import { runPollQuotes } from '../src/jobs/poll_quotes.js';
import { runPruneEvents } from '../src/jobs/prune_events.js';
import {
  createUniverseRepo, createMarketRepo, createOpsRepo, createEventsRepo,
} from '@stockagents/db';

const silent = { info() {}, warn() {}, error() {} };
const noSleep = () => Promise.resolve();

let client, repos;

before(async () => {
  client = await withTestDb();
  repos = {
    universe: createUniverseRepo(client),
    market: createMarketRepo(client),
    ops: createOpsRepo(client),
    events: createEventsRepo(client),
  };
});
beforeEach(async () => {
  await resetTables(client, ['quote_tick', 'indicator_snapshot', 'ohlcv_daily',
                             'ingest_errors', 'session_state', 'event_log', 'universe']);
  await repos.universe.upsertMany([
    { symbol: 'HOSE:FPT', exchange: 'HOSE', name: 'FPT' },
    { symbol: 'HOSE:VCB', exchange: 'HOSE', name: 'Vietcombank' },
  ]);
});
after(async () => { await client.close(); });

test('runIngestPrices ghi bars và indicator snapshot cho mọi mã', async () => {
  const broker = createBroker({ core: createFakeCore(), logger: silent, sleep: noSleep });

  const summary = await runIngestPrices({ broker, repos, logger: silent });

  assert.equal(summary.total, 2);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.failedSymbols, []);

  const bars = await client.query('SELECT COUNT(*)::int AS n FROM ohlcv_daily');
  assert.equal(bars.rows[0].n, 4); // 2 mã × 2 bar

  const snaps = await client.query('SELECT COUNT(*)::int AS n FROM indicator_snapshot');
  assert.equal(snaps.rows[0].n, 2);
});

test('runIngestPrices là idempotent — chạy hai lần không nhân đôi bars', async () => {
  const broker = createBroker({ core: createFakeCore(), logger: silent, sleep: noSleep });

  await runIngestPrices({ broker, repos, logger: silent });
  await runIngestPrices({ broker, repos, logger: silent });

  const bars = await client.query('SELECT COUNT(*)::int AS n FROM ohlcv_daily');
  assert.equal(bars.rows[0].n, 4);
});

test('runIngestPrices tiếp tục khi một mã lỗi và ghi vào ingest_errors', async () => {
  const core = createFakeCore();
  const original = core.data.getOhlcv;
  core.data.getOhlcv = async function (...args) {
    if (core.currentSymbol === 'HOSE:VCB') throw new Error('chart chưa sẵn sàng');
    return original.apply(this, args);
  };
  const broker = createBroker({ core, logger: silent, sleep: noSleep, maxRetries: 1 });

  const summary = await runIngestPrices({ broker, repos, logger: silent });

  assert.equal(summary.succeeded, 1);
  assert.deepEqual(summary.failedSymbols, ['HOSE:VCB']);

  const errs = await client.query('SELECT job, symbol FROM ingest_errors');
  assert.equal(errs.rows.length, 1);
  assert.equal(errs.rows[0].job, 'ingest_prices');
  assert.equal(errs.rows[0].symbol, 'HOSE:VCB');
});

test('runIngestPrices đặt session_state là DATA_READY khi mọi mã thành công', async () => {
  const broker = createBroker({ core: createFakeCore(), logger: silent, sleep: noSleep });
  const summary = await runIngestPrices({ broker, repos, logger: silent });

  const state = await repos.ops.getSessionState(summary.tradeDate);
  assert.equal(state.state, 'DATA_READY');
  assert.ok(state.data_captured_at instanceof Date);
});

test('runIngestPrices đặt session_state là DATA_STALE khi mọi mã đều lỗi', async () => {
  const core = createFakeCore({ failFirst: 99 });
  const broker = createBroker({ core, logger: silent, sleep: noSleep, maxRetries: 1 });

  const summary = await runIngestPrices({ broker, repos, logger: silent });

  assert.equal(summary.succeeded, 0);
  const state = await repos.ops.getSessionState(summary.tradeDate);
  assert.equal(state.state, 'DATA_STALE');
});

test('runIngestPrices phát sự kiện data.ingested', async () => {
  const broker = createBroker({ core: createFakeCore(), logger: silent, sleep: noSleep });
  await runIngestPrices({ broker, repos, logger: silent });

  const events = await repos.events.getEventsSince(0, 10);
  const ingested = events.find(e => e.type === 'data.ingested');
  assert.ok(ingested, 'phải có sự kiện data.ingested');
  assert.equal(ingested.payload.job, 'ingest_prices');
  assert.equal(ingested.payload.succeeded, 2);
});

test('runIngestPrices dừng sớm và phát data.stale khi CDP không kết nối được', async () => {
  const core = createFakeCore({ healthy: false });
  core.health.launch = async () => { throw new Error('không tìm thấy TradingView'); };
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  const summary = await runIngestPrices({ broker, repos, logger: silent });

  assert.equal(summary.total, 0);
  assert.equal(summary.succeeded, 0);

  const events = await repos.events.getEventsSince(0, 10);
  assert.ok(events.some(e => e.type === 'data.stale'));
});

test('runPollQuotes ghi tick cho các mã truyền vào', async () => {
  const broker = createBroker({ core: createFakeCore(), logger: silent, sleep: noSleep });

  const result = await runPollQuotes({
    broker, repos, symbols: ['HOSE:FPT', 'HOSE:VCB'], logger: silent,
  });

  assert.equal(result.inserted, 2);
  assert.equal(result.failed, 0);

  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM quote_tick');
  assert.equal(rows[0].n, 2);
});

test('runPollQuotes không làm gì khi danh sách mã rỗng', async () => {
  const broker = createBroker({ core: createFakeCore(), logger: silent, sleep: noSleep });
  const result = await runPollQuotes({ broker, repos, symbols: [], logger: silent });
  assert.deepEqual(result, { inserted: 0, failed: 0 });
});

test('runPruneEvents xóa sự kiện quá hạn', async () => {
  await client.query(
    `INSERT INTO event_log (ts, type, payload) VALUES (now() - interval '100 days', 'old', '{}')`);
  await repos.events.appendEvent({ type: 'new', payload: {} });

  const result = await runPruneEvents({ repos, retentionDays: 90, logger: silent });
  assert.equal(result.deleted, 1);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/data-service/tests/ingest_prices.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/jobs/ingest_prices.js'`.

- [ ] **Step 3: Cài đặt `packages/data-service/src/jobs/ingest_prices.js`**

```js
import { collectPrices } from '../collectors/prices.js';
import { collectIndicators } from '../collectors/indicators.js';
import { ensureStudies } from '../cdp/studies.js';
import { nowVnDate } from '../lib/vn_time.js';

const JOB = 'ingest_prices';

/**
 * Ingest giá + chỉ báo cho toàn bộ universe.
 * Lỗi một mã không chặn các mã còn lại (spec §5.3).
 */
export async function runIngestPrices({ broker, repos, logger = console, barCount = 60 }) {
  const startedAt = Date.now();
  const tradeDate = nowVnDate();

  const connected = await broker.ensureConnected();
  if (!connected) {
    await repos.ops.setSessionState(tradeDate, 'DATA_STALE', {
      note: 'không kết nối được CDP',
    });
    await repos.ops.logIngestError(JOB, null, 'không kết nối được CDP');
    await repos.events.appendEvent({
      type: 'data.stale',
      payload: { job: JOB, reason: 'cdp_unavailable' },
    });
    logger.error('[ingest_prices] bỏ qua: CDP không khả dụng');
    return { tradeDate, total: 0, succeeded: 0, failed: 0, failedSymbols: [], durationMs: Date.now() - startedAt };
  }

  try {
    const added = await ensureStudies(broker);
    if (added.length) logger.info(`[ingest_prices] đã thêm chỉ báo: ${added.join(', ')}`);
  } catch (err) {
    logger.warn(`[ingest_prices] không thiết lập được chỉ báo: ${err.message}`);
    await repos.ops.logIngestError(JOB, null, `ensureStudies: ${err.message}`);
  }

  const symbols = (await repos.universe.listActive()).map(s => s.symbol);
  const failedSymbols = [];
  let succeeded = 0;

  for (const symbol of symbols) {
    try {
      const bars = await collectPrices(broker, symbol, { count: barCount });
      await repos.market.upsertOhlcvBars(symbol, bars);

      const { raw, parsed } = await collectIndicators(broker, symbol);
      await repos.market.insertIndicatorSnapshot(symbol, { ...parsed, _raw: raw });

      succeeded++;
      logger.info(`[ingest_prices] ${symbol}: ${bars.length} bar`);
    } catch (err) {
      failedSymbols.push(symbol);
      await repos.ops.logIngestError(JOB, symbol, err.message);
      logger.warn(`[ingest_prices] ${symbol} lỗi: ${err.message}`);
    }
  }

  const durationMs = Date.now() - startedAt;
  const state = succeeded > 0 ? 'DATA_READY' : 'DATA_STALE';

  await repos.ops.setSessionState(tradeDate, state, {
    dataCapturedAt: succeeded > 0 ? new Date() : null,
    note: `${succeeded}/${symbols.length} mã thành công`,
  });

  await repos.events.appendEvent({
    type: succeeded > 0 ? 'data.ingested' : 'data.stale',
    payload: {
      job: JOB, tradeDate, total: symbols.length,
      succeeded, failed: failedSymbols.length, failedSymbols, durationMs,
    },
  });

  logger.info(
    `[ingest_prices] xong: ${succeeded}/${symbols.length} mã trong ${(durationMs / 1000).toFixed(1)}s`);

  return {
    tradeDate, total: symbols.length, succeeded,
    failed: failedSymbols.length, failedSymbols, durationMs,
  };
}
```

- [ ] **Step 4: Cài đặt `packages/data-service/src/jobs/poll_quotes.js`**

```js
import { collectQuotes } from '../collectors/quotes.js';

const JOB = 'poll_quotes';

export async function runPollQuotes({ broker, repos, symbols, logger = console }) {
  if (!symbols || symbols.length === 0) return { inserted: 0, failed: 0 };

  const { ticks, errors } = await collectQuotes(broker, symbols);
  const inserted = await repos.market.insertQuoteTicks(ticks);

  for (const e of errors) {
    await repos.ops.logIngestError(JOB, e.symbol, e.message);
  }

  logger.info(`[poll_quotes] ${inserted} tick, ${errors.length} lỗi`);
  return { inserted, failed: errors.length };
}
```

- [ ] **Step 5: Cài đặt `packages/data-service/src/jobs/prune_events.js`**

```js
export async function runPruneEvents({ repos, retentionDays, logger = console }) {
  const deleted = await repos.events.pruneOlderThan(retentionDays);
  logger.info(`[prune_events] đã xóa ${deleted} sự kiện cũ hơn ${retentionDays} ngày`);
  return { deleted };
}
```

- [ ] **Step 6: Chạy test, xác nhận thành công**

```bash
node --test packages/data-service/tests/ingest_prices.test.js
```

Kỳ vọng: PASS — 10 test.

- [ ] **Step 7: Commit**

```bash
git add packages/data-service/src/jobs packages/data-service/tests/ingest_prices.test.js
git commit -m "feat(data-service): ingest, quote polling and event pruning jobs"
```

---

### Task 9: Scheduler, entry point, CLI và tài liệu

**Files:**
- Create: `packages/data-service/src/scheduler.js`
- Create: `packages/data-service/src/index.js`
- Create: `packages/data-service/src/cli.js`
- Create: `ecosystem.config.cjs`
- Create: `README.md`
- Test: `packages/data-service/tests/scheduler.test.js`

**Interfaces:**
- Consumes: các job từ Task 8, repositories từ Task 4–5.
- Produces:
  - `SCHEDULES` → `[{ name, cron, job }]`
  - `startScheduler({ jobs, cronLib, logger }) → { stop() }`
  - `createRepos(client) → { universe, market, ops, events }`

- [ ] **Step 1: Viết test thất bại**

`packages/data-service/tests/scheduler.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEDULES, startScheduler } from '../src/scheduler.js';

const silent = { info() {}, warn() {}, error() {} };

function fakeCronLib() {
  const registered = [];
  return {
    registered,
    schedule(expr, fn, opts) {
      registered.push({ expr, fn, opts });
      return { stop() { registered.splice(registered.indexOf(this), 1); } };
    },
  };
}

test('SCHEDULES định nghĩa đủ ba job theo spec §5.2', () => {
  const names = SCHEDULES.map(s => s.name);
  assert.deepEqual(names.sort(), ['ingest_prices', 'poll_quotes', 'prune_events']);
});

test('cron của ingest_prices chạy 08:30 các ngày T2–T6', () => {
  const s = SCHEDULES.find(s => s.name === 'ingest_prices');
  assert.equal(s.cron, '30 8 * * 1-5');
});

test('cron của poll_quotes chạy mỗi 5 phút trong giờ giao dịch', () => {
  const s = SCHEDULES.find(s => s.name === 'poll_quotes');
  assert.equal(s.cron, '*/5 9-14 * * 1-5');
});

test('startScheduler đăng ký mọi job với múi giờ Việt Nam', () => {
  const cronLib = fakeCronLib();
  startScheduler({ jobs: { ingest_prices: async () => {}, poll_quotes: async () => {}, prune_events: async () => {} },
                   cronLib, logger: silent });

  assert.equal(cronLib.registered.length, 3);
  for (const r of cronLib.registered) {
    assert.equal(r.opts.timezone, 'Asia/Ho_Chi_Minh');
  }
});

test('job ném lỗi không làm sập scheduler', async () => {
  const cronLib = fakeCronLib();
  startScheduler({
    jobs: {
      ingest_prices: async () => { throw new Error('bùm'); },
      poll_quotes: async () => {},
      prune_events: async () => {},
    },
    cronLib, logger: silent,
  });

  const entry = cronLib.registered.find(r => r.expr === '30 8 * * 1-5');
  await assert.doesNotReject(() => entry.fn());
});

test('stop hủy mọi job đã đăng ký', () => {
  const cronLib = fakeCronLib();
  const scheduler = startScheduler({
    jobs: { ingest_prices: async () => {}, poll_quotes: async () => {}, prune_events: async () => {} },
    cronLib, logger: silent,
  });

  scheduler.stop();
  assert.equal(cronLib.registered.length, 0);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/data-service/tests/scheduler.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/scheduler.js'`.

- [ ] **Step 3: Cài đặt `packages/data-service/src/scheduler.js`**

```js
import cron from 'node-cron';

const TZ = 'Asia/Ho_Chi_Minh';

export const SCHEDULES = [
  { name: 'ingest_prices', cron: '30 8 * * 1-5' },
  // Cron cố ý để RỘNG. HOSE nghỉ trưa 11:30–13:00 và cửa sổ poll chỉ là
  // 09:20–14:30 — cron không diễn đạt nổi khoảng nghỉ giữa ngày mà vẫn đọc
  // được, và chuỗi cron thì KHÔNG unit-test được. Việc chặn ngoài giờ giao
  // cho isTradingWindow() trong vn_time.js: một vị từ có bảng test case.
  { name: 'poll_quotes', cron: '*/5 9-14 * * 1-5' },
  { name: 'prune_events', cron: '0 2 * * *' },
];

/**
 * `cronLib` được truyền vào để test không phải chờ đồng hồ thật.
 * Job ném lỗi được nuốt và ghi log — một job hỏng không được làm sập tiến trình.
 */
export function startScheduler({ jobs, cronLib = cron, logger = console }) {
  const tasks = SCHEDULES.map(({ name, cron: expr }) => {
    const fn = jobs[name];
    if (!fn) throw new Error(`startScheduler: thiếu hàm cho job "${name}"`);

    const wrapped = async () => {
      try {
        await fn();
      } catch (err) {
        logger.error(`[scheduler] job ${name} lỗi: ${err.stack || err.message}`);
      }
    };

    logger.info(`[scheduler] đăng ký ${name} — ${expr} (${TZ})`);
    return cronLib.schedule(expr, wrapped, { timezone: TZ });
  });

  return { stop() { for (const t of tasks) t.stop(); } };
}
```

- [ ] **Step 4: Chạy test, xác nhận thành công**

```bash
node --test packages/data-service/tests/scheduler.test.js
```

Kỳ vọng: PASS — 6 test.

- [ ] **Step 5: Cài đặt `packages/data-service/src/index.js`**

```js
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import * as core from 'tradingview-mcp/core';
import {
  createClient, loadConfig,
  createUniverseRepo, createMarketRepo, createOpsRepo, createEventsRepo,
} from '@stockagents/db';
import { createBroker } from './cdp/broker.js';
import { startScheduler } from './scheduler.js';
import { runIngestPrices } from './jobs/ingest_prices.js';
import { runPollQuotes } from './jobs/poll_quotes.js';
import { runPruneEvents } from './jobs/prune_events.js';

export function createRepos(client) {
  return {
    universe: createUniverseRepo(client),
    market: createMarketRepo(client),
    ops: createOpsRepo(client),
    events: createEventsRepo(client),
  };
}

async function seedUniverse(repos) {
  const raw = await readFile(new URL('../../../config/universe.json', import.meta.url), 'utf8');
  const n = await repos.universe.upsertMany(JSON.parse(raw));
  console.log(`[data-service] universe: ${n} mã`);
}

async function main() {
  const cfg = loadConfig();
  const client = createClient(cfg.databaseUrl);
  const repos = createRepos(client);
  const broker = createBroker({ core });

  await seedUniverse(repos);

  const scheduler = startScheduler({
    jobs: {
      ingest_prices: () => runIngestPrices({ broker, repos }),
      // Phase 1 chưa có vị thế nên poll toàn universe.
      // Phase 3 sẽ thay bằng hợp nhất các mã đang giữ của 5 agent.
      poll_quotes: async () => {
        const symbols = (await repos.universe.listActive()).map(s => s.symbol);
        return runPollQuotes({ broker, repos, symbols });
      },
      prune_events: () => runPruneEvents({ repos, retentionDays: cfg.eventLogRetentionDays }),
    },
  });

  const shutdown = async (signal) => {
    console.log(`[data-service] nhận ${signal}, đang dừng...`);
    scheduler.stop();
    await client.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log('[data-service] đã khởi động');
}

// Chỉ chạy scheduler khi file này là entry point.
// `cli.js` import `createRepos` từ đây — không có guard thì chạy CLI
// sẽ vô tình khởi động luôn scheduler.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[data-service] lỗi khởi động:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 6: Cài đặt `packages/data-service/src/cli.js`**

```js
import * as core from 'tradingview-mcp/core';
import { createClient, loadConfig } from '@stockagents/db';
import { createBroker } from './cdp/broker.js';
import { createRepos } from './index.js';
import { runIngestPrices } from './jobs/ingest_prices.js';
import { runPollQuotes } from './jobs/poll_quotes.js';

const COMMANDS = {
  async 'ingest-prices'({ broker, repos }) {
    return runIngestPrices({ broker, repos });
  },
  async 'poll-quotes'({ broker, repos }) {
    const symbols = (await repos.universe.listActive()).map(s => s.symbol);
    return runPollQuotes({ broker, repos, symbols });
  },
};

const name = process.argv[2];
const command = COMMANDS[name];

if (!command) {
  console.error(`Lệnh không hợp lệ: ${name}`);
  console.error(`Có sẵn: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(1);
}

const cfg = loadConfig();
const client = createClient(cfg.databaseUrl);
const repos = createRepos(client);
const broker = createBroker({ core });

command({ broker, repos })
  .then(async (result) => {
    console.log(JSON.stringify(result, null, 2));
    await client.close();
  })
  .catch(async (err) => {
    console.error(err.stack || err.message);
    await client.close();
    process.exit(1);
  });
```

Kiểm tra guard entry-point ở Step 5 hoạt động đúng — chạy CLI **không** được khởi động scheduler:

```bash
node packages/data-service/src/cli.js nope
```

Kỳ vọng: in `Lệnh không hợp lệ: nope`, thoát ngay, **không** có dòng `[scheduler] đăng ký ...`.

- [ ] **Step 7: Tạo `ecosystem.config.cjs`**

```js
module.exports = {
  apps: [
    {
      name: 'data-service',
      script: 'packages/data-service/src/index.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      error_file: 'logs/data-service-error.log',
      out_file: 'logs/data-service-out.log',
      time: true,
    },
  ],
};
```

- [ ] **Step 8: Tạo `README.md`**

```markdown
# StockAgents

Hệ thống multi-agent AI giao dịch chứng khoán Việt Nam — **hoàn toàn giả lập**.
Không kết nối tới môi giới thật, không đặt lệnh bằng tiền thật.

Thiết kế: [docs/superpowers/specs/2026-07-26-ai-trading-agents-design.md](docs/superpowers/specs/2026-07-26-ai-trading-agents-design.md)

## Yêu cầu

- Node.js >= 20.20
- PostgreSQL 18 (pgvector chỉ cần từ Phase 6)
- TradingView Desktop chạy với CDP port 9222 (cho data-service)

## Cài đặt

```bash
npm install
cp .env.example .env      # điền DATABASE_URL
npm run migrate
```

## Chạy

```bash
npm run data-service      # scheduler chạy nền
npm run ingest:prices     # chạy tay một lần
npm run poll:quotes
```

## Test

```bash
npm test                  # cần DATABASE_URL_TEST
```

## Phase 1 gồm những gì

`packages/db` — schema, migrations, repositories.
`packages/data-service` — CDP broker, collectors, jobs, scheduler.

Chỉ `packages/data-service/src/cdp/broker.js` được import `tradingview-mcp`.
Mọi thành phần khác đọc từ database.
```

- [ ] **Step 9: Chạy toàn bộ test**

```bash
npm test
```

Kỳ vọng: PASS — 74 test, 0 fail.

Phân bổ: config 6, migrate 4, schema 5, events 7, market 13, broker 9, vn_time 5, collectors 9, ingest 10, scheduler 6.

- [ ] **Step 10: Kiểm chứng end-to-end với TradingView thật**

Mở TradingView Desktop rồi:

```bash
npm run ingest:prices
```

Kỳ vọng: JSON in ra có `succeeded` bằng số mã trong universe, `failed: 0`. Kiểm tra DB:

```bash
psql "$DATABASE_URL" -c "SELECT symbol, COUNT(*) FROM ohlcv_daily GROUP BY symbol ORDER BY symbol LIMIT 5;"
psql "$DATABASE_URL" -c "SELECT symbol, payload->>'rsi14' AS rsi FROM indicator_snapshot ORDER BY captured_at DESC LIMIT 5;"
```

Kỳ vọng: mỗi mã có ~60 dòng OHLCV; cột `rsi` có giá trị số.

- [ ] **Step 11: Commit**

```bash
git add packages/data-service ecosystem.config.cjs README.md
git commit -m "feat(data-service): scheduler, entry point, CLI and docs"
```

---

## Điều kiện hoàn thành Phase 1

- [ ] `npm test` xanh toàn bộ (74 test)
- [ ] `npm run migrate` áp dụng sạch lên DB trống
- [ ] `npm run ingest:prices` ingest đủ 30 mã VN30 với `failed: 0`
- [ ] Chạy `ingest:prices` hai lần không nhân đôi dữ liệu
- [ ] Tắt TradingView rồi chạy `ingest:prices` → kết thúc êm, ghi `DATA_STALE`, không crash
- [ ] `grep -rl "tradingview-mcp" packages/ --include=*.js` chỉ trả về `broker.js`, `index.js`, `cli.js`
- [ ] `event_log` có bản ghi `data.ingested` sau mỗi lần chạy

---

## Ghi chú cho Phase 2

- `poll_quotes` hiện poll toàn universe. Phase 3 sẽ đổi thành hợp nhất các mã đang giữ của 5 agent (spec §5.2).
- Bảng `agents` đã tồn tại nhưng chưa có dữ liệu. Phase 2 seed agent đầu tiên.
- Phase 6 cần migration `005_pgvector.sql`: cài pgvector cho PG18, `CREATE EXTENSION vector`, `ALTER TABLE news_items ADD COLUMN embedding VECTOR(1536)`, tương tự cho `lessons`, rồi index ivfflat (tạo sau khi đã có dữ liệu mẫu — ivfflat trên bảng rỗng cho kết quả kém).
- `isTradingDay()` chưa xét ngày lễ Việt Nam. Bổ sung khi có mã chạy thật qua kỳ nghỉ.
