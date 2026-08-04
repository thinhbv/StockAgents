# Phase 3 — Orchestrator & Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent tự thoát vị thế. Watchdog đối chiếu `exitPlan` với `quote_tick` mỗi 5 phút bằng số học thuần, và **chỉ** đánh thức LLM khi chạm ngưỡng.

**Architecture:** Đánh giá trigger là **hàm thuần** — không DB, không LLM, không đồng hồ hệ thống (thời gian truyền vào). Watchdog là tầng mỏng nối hàm thuần đó với DB: cập nhật đỉnh giá, chống rung (debounce), đánh thức agent, phát sự kiện. Orchestrator là máy trạng thái điều phối trọn một phiên.

**Tech Stack:** Node.js 20/22 (ESM), PostgreSQL 18, `pg`, `node --test`. Không thêm dependency.

## Global Constraints

- JavaScript ESM only. Không TypeScript, không build step. Node >= 20.20.
- **Chạy test bằng `npm test`** (script `scripts/run-tests.mjs`). Không dùng glob hay thư mục với `node --test` — cách truyền tham số khác nhau giữa Node 20 và 22.
- Mọi hàm repository chạm bảng có `agent_id` bắt buộc gọi `assertAgentScope`.
- **LLM không giữ quy tắc an toàn** (spec §3.3). Watchdog quyết định *có đánh thức hay không* bằng số học; engine vẫn là trọng tài của mọi lệnh.
- Không sửa gì trong `tradingview_mcp/`. Không import `tradingview-mcp` ở package này.
- Tiền tệ `NUMERIC(20,2)`. Ngày giao dịch theo `Asia/Ho_Chi_Minh`.
- Mọi file test **tự chứa**: chạy riêng được, chạy hai lần liên tiếp vẫn xanh.
- Conventional Commits. Tác giả: `git -c user.email=claudeai07@vhec.vn -c user.name="Claude"`.

## Nguyên tắc chi phối Phase này

**Token tỉ lệ với số SỰ KIỆN, không phải số PHÚT.** Watchdog chạy mỗi 5 phút suốt phiên — khoảng 60 nhịp/ngày. Nếu mỗi nhịp gọi LLM cho mọi vị thế, một agent 8 vị thế tốn 480 lời gọi/ngày. Với `exitPlan`, con số đó rơi xuống vài lần. Vì vậy **không được** để bất kỳ đường nào trong watchdog gọi LLM khi chưa có trigger.

## File Structure

| File | Trách nhiệm |
|---|---|
| `packages/agent-runtime/src/orchestrator/triggers.js` | Hàm thuần: đánh giá exitPlan → danh sách trigger |
| `packages/agent-runtime/src/orchestrator/watchdog.js` | Cập nhật đỉnh giá, chống rung, đánh thức agent, phát sự kiện |
| `packages/agent-runtime/src/orchestrator/session.js` | Máy trạng thái: PRE_OPEN → OPEN → WATCHING → CLOSING |
| `packages/agent-runtime/src/orchestrator/events.js` | Tên và hình dạng sự kiện phát ra |
| `packages/db/migrations/007_trigger_log.sql` | Bảng lưu lần cuối mỗi trigger nổ (chống rung) |
| `packages/db/src/repositories/triggers.js` | Repo cho `trigger_log` |
| `packages/agent-runtime/src/cli_day.js` | Chạy tay trọn một ngày mô phỏng |

---

### Task 1: Đánh giá trigger (hàm thuần)

**Files:**
- Create: `packages/agent-runtime/src/orchestrator/triggers.js`
- Test: `packages/agent-runtime/tests/triggers.test.js`

**Interfaces:**
- Consumes: không
- Produces:
  - `TRIGGER_TYPES = ['TAKE_PROFIT','STOP_LOSS','TRAILING','TIME_STOP','NEWS_ALERT','EOD_REVIEW']`
  - `DEBOUNCE_MINUTES = 30`
  - `evaluateTriggers({ position, lastPriceVnd, now, heldDays, newsSentiment }) → Trigger[]`
    `Trigger = { type, symbol, reason, unrealizedPct }`
  - `isDebounced({ lastFiredAt, now, minutes }) → boolean`
  - `position` cần: `{ symbol, avgCostVnd, peakPriceVnd, exitPlan }`
  - `exitPlan` các trường tùy chọn: `takeProfitPct`, `stopLossPct`, `timeStopDays`, `trailingPct`

- [ ] **Step 1: Viết test thất bại**

`packages/agent-runtime/tests/triggers.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRIGGER_TYPES, DEBOUNCE_MINUTES, evaluateTriggers, isDebounced,
} from '../src/orchestrator/triggers.js';

const pos = (over = {}) => ({
  symbol: 'HOSE:FPT',
  avgCostVnd: 100_000,
  peakPriceVnd: 100_000,
  exitPlan: { takeProfitPct: 8, stopLossPct: -4, timeStopDays: 10, trailingPct: 3 },
  ...over,
});
const NOW = new Date('2026-07-20T10:00:00+07:00');
const types = (list) => list.map(t => t.type).sort();

test('danh sách trigger đúng spec §6.3', () => {
  assert.deepEqual([...TRIGGER_TYPES].sort(),
    ['EOD_REVIEW', 'NEWS_ALERT', 'STOP_LOSS', 'TAKE_PROFIT', 'TIME_STOP', 'TRAILING'].sort());
  assert.equal(DEBOUNCE_MINUTES, 30);
});

test('giá đi ngang trong ngưỡng: không trigger nào nổ', () => {
  const t = evaluateTriggers({ position: pos(), lastPriceVnd: 101_000, now: NOW, heldDays: 1 });
  assert.deepEqual(t, []);
});

test('TAKE_PROFIT nổ khi lãi chạm ngưỡng', () => {
  const t = evaluateTriggers({ position: pos(), lastPriceVnd: 108_000, now: NOW, heldDays: 1 });
  assert.ok(types(t).includes('TAKE_PROFIT'));
  assert.equal(t.find(x => x.type === 'TAKE_PROFIT').unrealizedPct, 8);
});

test('TAKE_PROFIT KHÔNG nổ khi còn thiếu một chút', () => {
  const t = evaluateTriggers({ position: pos(), lastPriceVnd: 107_900, now: NOW, heldDays: 1 });
  assert.equal(types(t).includes('TAKE_PROFIT'), false);
});

test('STOP_LOSS nổ khi lỗ chạm ngưỡng', () => {
  const t = evaluateTriggers({ position: pos(), lastPriceVnd: 96_000, now: NOW, heldDays: 1 });
  assert.ok(types(t).includes('STOP_LOSS'));
});

test('TRAILING nổ khi tụt đủ sâu từ ĐỈNH, không phải từ giá vốn', () => {
  // đỉnh 120.000, tụt 3% -> 116.400. Vẫn lãi 16% so với vốn nhưng phải nổ.
  const t = evaluateTriggers({
    position: pos({ peakPriceVnd: 120_000 }), lastPriceVnd: 116_000, now: NOW, heldDays: 1,
  });
  assert.ok(types(t).includes('TRAILING'), 'trailing phải tính từ đỉnh');
});

test('TRAILING không nổ khi giá vẫn sát đỉnh', () => {
  const t = evaluateTriggers({
    position: pos({ peakPriceVnd: 120_000 }), lastPriceVnd: 118_000, now: NOW, heldDays: 1,
  });
  assert.equal(types(t).includes('TRAILING'), false);
});

test('TIME_STOP nổ khi giữ đủ số phiên', () => {
  const t = evaluateTriggers({ position: pos(), lastPriceVnd: 101_000, now: NOW, heldDays: 10 });
  assert.ok(types(t).includes('TIME_STOP'));
});

test('NEWS_ALERT nổ khi tin rất tiêu cực', () => {
  const t = evaluateTriggers({
    position: pos(), lastPriceVnd: 101_000, now: NOW, heldDays: 1, newsSentiment: -0.8,
  });
  assert.ok(types(t).includes('NEWS_ALERT'));
});

test('NEWS_ALERT không nổ với tin hơi tiêu cực', () => {
  const t = evaluateTriggers({
    position: pos(), lastPriceVnd: 101_000, now: NOW, heldDays: 1, newsSentiment: -0.2,
  });
  assert.equal(types(t).includes('NEWS_ALERT'), false);
});

test('EOD_REVIEW nổ từ 14:30 giờ VN trở đi', () => {
  const eod = new Date('2026-07-20T14:30:00+07:00');
  const t = evaluateTriggers({ position: pos(), lastPriceVnd: 101_000, now: eod, heldDays: 1 });
  assert.ok(types(t).includes('EOD_REVIEW'));
});

test('EOD_REVIEW chưa nổ lúc 14:29', () => {
  const before = new Date('2026-07-20T14:29:00+07:00');
  const t = evaluateTriggers({ position: pos(), lastPriceVnd: 101_000, now: before, heldDays: 1 });
  assert.equal(types(t).includes('EOD_REVIEW'), false);
});

test('exitPlan rỗng chỉ còn EOD_REVIEW, không nổ gì khác', () => {
  const t = evaluateTriggers({
    position: pos({ exitPlan: {} }), lastPriceVnd: 200_000, now: NOW, heldDays: 99,
  });
  assert.deepEqual(t, []);
});

test('nhiều trigger có thể nổ cùng lúc', () => {
  const eod = new Date('2026-07-20T14:35:00+07:00');
  const t = evaluateTriggers({ position: pos(), lastPriceVnd: 108_000, now: eod, heldDays: 10 });
  assert.ok(t.length >= 3, `kỳ vọng nhiều trigger, nhận ${types(t).join(',')}`);
});

test('mỗi trigger mang lý do đọc được, không phải chỉ mã', () => {
  const t = evaluateTriggers({ position: pos(), lastPriceVnd: 108_000, now: NOW, heldDays: 1 });
  const tp = t.find(x => x.type === 'TAKE_PROFIT');
  assert.match(tp.reason, /8/);
  assert.equal(tp.symbol, 'HOSE:FPT');
});

test('giá không hợp lệ không làm nổ trigger nào và không ném lỗi', () => {
  assert.doesNotThrow(() => evaluateTriggers({ position: pos(), lastPriceVnd: NaN, now: NOW, heldDays: 1 }));
  assert.deepEqual(evaluateTriggers({ position: pos(), lastPriceVnd: NaN, now: NOW, heldDays: 1 }), []);
});

test('isDebounced chặn lần nổ thứ hai trong 30 phút', () => {
  const fired = new Date('2026-07-20T10:00:00+07:00');
  const soon = new Date('2026-07-20T10:20:00+07:00');
  const later = new Date('2026-07-20T10:31:00+07:00');
  assert.equal(isDebounced({ lastFiredAt: fired, now: soon, minutes: 30 }), true);
  assert.equal(isDebounced({ lastFiredAt: fired, now: later, minutes: 30 }), false);
});

test('isDebounced cho qua khi chưa từng nổ', () => {
  assert.equal(isDebounced({ lastFiredAt: null, now: NOW, minutes: 30 }), false);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/agent-runtime/tests/triggers.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/orchestrator/triggers.js'`.

- [ ] **Step 3: Cài đặt `packages/agent-runtime/src/orchestrator/triggers.js`**

```js
/**
 * Đánh giá điều kiện thoát — HÀM THUẦN.
 *
 * Đây là thứ chạy 60 lần mỗi ngày cho mỗi vị thế. Nó phải rẻ, tất định, và
 * KHÔNG BAO GIỜ gọi LLM. Cả cơ chế exitPlan tồn tại để chi phí token tỉ lệ
 * với số SỰ KIỆN chứ không phải số PHÚT (spec §6.3).
 *
 * Thời gian truyền vào qua `now` chứ không đọc đồng hồ hệ thống — nếu không
 * test sẽ phụ thuộc giờ chạy và chẳng chứng minh được gì.
 */

export const TRIGGER_TYPES = Object.freeze([
  'TAKE_PROFIT', 'STOP_LOSS', 'TRAILING', 'TIME_STOP', 'NEWS_ALERT', 'EOD_REVIEW',
]);

export const DEBOUNCE_MINUTES = 30;

// Ngưỡng tin xấu đủ mạnh để đánh thức agent. Tin hơi tiêu cực thì không —
// nếu không mỗi bản tin thường ngày đều tốn một lời gọi LLM.
const NEWS_ALERT_THRESHOLD = -0.5;

// 14:30 giờ VN — rà soát một lần trước khi đóng cửa.
const EOD_HOUR = 14;
const EOD_MINUTE = 30;

const vnParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false,
});

function vnHourMinute(now) {
  const parts = vnParts.formatToParts(now);
  const hour = Number(parts.find(p => p.type === 'hour').value);
  const minute = Number(parts.find(p => p.type === 'minute').value);
  return { hour, minute };
}

export function evaluateTriggers({ position, lastPriceVnd, now, heldDays, newsSentiment }) {
  const fired = [];
  const plan = position.exitPlan ?? {};
  const { symbol, avgCostVnd, peakPriceVnd } = position;

  if (!Number.isFinite(lastPriceVnd) || !Number.isFinite(avgCostVnd) || avgCostVnd <= 0) {
    return fired;
  }

  const unrealizedPct = Math.round(((lastPriceVnd - avgCostVnd) / avgCostVnd) * 10000) / 100;
  const add = (type, reason) => fired.push({ type, symbol, reason, unrealizedPct });

  if (Number.isFinite(plan.takeProfitPct) && unrealizedPct >= plan.takeProfitPct) {
    add('TAKE_PROFIT', `lãi ${unrealizedPct}% chạm mục tiêu ${plan.takeProfitPct}%`);
  }

  if (Number.isFinite(plan.stopLossPct) && unrealizedPct <= plan.stopLossPct) {
    add('STOP_LOSS', `lỗ ${unrealizedPct}% chạm ngưỡng cắt ${plan.stopLossPct}%`);
  }

  // Trailing tính từ ĐỈNH kể từ lúc mua, không phải từ giá vốn. Một vị thế
  // đang lãi 16% vẫn phải nổ nếu đã tụt đủ sâu khỏi đỉnh 20%.
  if (Number.isFinite(plan.trailingPct) && Number.isFinite(peakPriceVnd) && peakPriceVnd > 0) {
    const dropPct = Math.round(((peakPriceVnd - lastPriceVnd) / peakPriceVnd) * 10000) / 100;
    if (dropPct >= plan.trailingPct) {
      add('TRAILING', `tụt ${dropPct}% từ đỉnh ${peakPriceVnd} (ngưỡng ${plan.trailingPct}%)`);
    }
  }

  if (Number.isFinite(plan.timeStopDays) && Number.isFinite(heldDays)
      && heldDays >= plan.timeStopDays) {
    add('TIME_STOP', `đã giữ ${heldDays} phiên, chạm hạn ${plan.timeStopDays} phiên`);
  }

  if (Number.isFinite(newsSentiment) && newsSentiment <= NEWS_ALERT_THRESHOLD) {
    add('NEWS_ALERT', `tin tiêu cực mạnh (sentiment ${newsSentiment})`);
  }

  // EOD_REVIEW chỉ áp dụng cho vị thế CÓ kế hoạch thoát. Vị thế không khai
  // exitPlan là agent cố ý không đặt điều kiện — đừng đánh thức nó vô cớ.
  if (Object.keys(plan).length > 0) {
    const { hour, minute } = vnHourMinute(now);
    if (hour > EOD_HOUR || (hour === EOD_HOUR && minute >= EOD_MINUTE)) {
      add('EOD_REVIEW', 'rà soát trước khi đóng cửa phiên');
    }
  }

  return fired;
}

export function isDebounced({ lastFiredAt, now, minutes = DEBOUNCE_MINUTES }) {
  if (!lastFiredAt) return false;
  const elapsedMs = now.getTime() - new Date(lastFiredAt).getTime();
  return elapsedMs < minutes * 60_000;
}
```

- [ ] **Step 4: Chạy test hai lần và toàn suite**

```bash
node --test packages/agent-runtime/tests/triggers.test.js
node --test packages/agent-runtime/tests/triggers.test.js
npm test
```

Kỳ vọng: 18/18 cả hai lần; toàn suite xanh.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(orchestrator): pure exit-plan trigger evaluation"
```

---

### Task 2: Bảng chống rung và repository

**Files:**
- Create: `packages/db/migrations/007_trigger_log.sql`
- Create: `packages/db/src/repositories/triggers.js`
- Modify: `packages/db/src/index.js` (thêm export)
- Test: `packages/db/tests/triggers_repo.test.js`

**Interfaces:**
- Consumes: `assertAgentScope`
- Produces:
  - `createTriggersRepo(client)` → `{ getLastFired(agentId, symbol, type), recordFired(agentId, symbol, type, firedAt), listRecent(agentId, limit) }`
  - `getLastFired` trả `Date | null`

- [ ] **Step 1: Tạo `packages/db/migrations/007_trigger_log.sql`**

```sql
-- Chống rung cho watchdog: một vị thế không được đánh thức quá 1 lần / 30 phút
-- cho CÙNG loại trigger. Không có bảng này, một mã dao động quanh ngưỡng
-- cắt lỗ sẽ gọi LLM mỗi 5 phút suốt phiên.
--
-- Lưu theo (agent, mã, loại) chứ không theo position_id: vị thế đóng rồi mở
-- lại trong ngày vẫn phải chịu chung nhịp chống rung.

CREATE TABLE trigger_log (
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  symbol     TEXT NOT NULL REFERENCES universe(symbol),
  type       TEXT NOT NULL,
  fired_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (agent_id, symbol, type)
);

CREATE INDEX trigger_log_agent_time_idx ON trigger_log (agent_id, fired_at DESC);
```

- [ ] **Step 2: Viết test thất bại**

`packages/db/tests/triggers_repo.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo } from '../src/repositories/agents.js';
import { createTriggersRepo } from '../src/repositories/triggers.js';

let client, agents, triggers;
const TABLES = ['trigger_log', 'portfolio_snapshot', 'agents', 'universe'];

before(async () => {
  client = await withTestDb();
  agents = createAgentsRepo(client);
  triggers = createTriggersRepo(client);
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE')`);
  await agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1000000000 },
    { id: 'a2', name: 'A2', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1000000000 },
  ]);
});
after(async () => { await client.close(); });

test('hàm agent-scoped từ chối khi thiếu agentId', async () => {
  await assert.rejects(() => triggers.getLastFired(null, 'HOSE:FPT', 'STOP_LOSS'), /agentId/);
  await assert.rejects(() => triggers.recordFired('', 'HOSE:FPT', 'STOP_LOSS', new Date()), /agentId/);
});

test('chưa từng nổ thì trả null', async () => {
  assert.equal(await triggers.getLastFired('a1', 'HOSE:FPT', 'STOP_LOSS'), null);
});

test('recordFired lưu và đọc lại đúng thời điểm', async () => {
  const at = new Date('2026-07-20T10:00:00Z');
  await triggers.recordFired('a1', 'HOSE:FPT', 'STOP_LOSS', at);
  const got = await triggers.getLastFired('a1', 'HOSE:FPT', 'STOP_LOSS');
  assert.equal(got.getTime(), at.getTime());
});

test('nổ lại cùng loại thì ghi đè thời điểm, không tạo hàng mới', async () => {
  await triggers.recordFired('a1', 'HOSE:FPT', 'STOP_LOSS', new Date('2026-07-20T10:00:00Z'));
  await triggers.recordFired('a1', 'HOSE:FPT', 'STOP_LOSS', new Date('2026-07-20T11:00:00Z'));

  const { rows } = await client.query(`SELECT count(*)::int n FROM trigger_log WHERE agent_id='a1'`);
  assert.equal(rows[0].n, 1);
  const got = await triggers.getLastFired('a1', 'HOSE:FPT', 'STOP_LOSS');
  assert.equal(got.toISOString(), '2026-07-20T11:00:00.000Z');
});

test('các loại trigger khác nhau đếm nhịp riêng', async () => {
  await triggers.recordFired('a1', 'HOSE:FPT', 'STOP_LOSS', new Date('2026-07-20T10:00:00Z'));
  assert.equal(await triggers.getLastFired('a1', 'HOSE:FPT', 'TAKE_PROFIT'), null);
});

test('agent này không thấy nhịp chống rung của agent kia', async () => {
  await triggers.recordFired('a2', 'HOSE:FPT', 'STOP_LOSS', new Date('2026-07-20T10:00:00Z'));
  assert.equal(await triggers.getLastFired('a1', 'HOSE:FPT', 'STOP_LOSS'), null);
});

test('listRecent trả về theo thứ tự mới nhất trước, chỉ của agent đó', async () => {
  await triggers.recordFired('a1', 'HOSE:FPT', 'STOP_LOSS', new Date('2026-07-20T10:00:00Z'));
  await triggers.recordFired('a1', 'HOSE:FPT', 'TAKE_PROFIT', new Date('2026-07-20T11:00:00Z'));
  await triggers.recordFired('a2', 'HOSE:FPT', 'TIME_STOP', new Date('2026-07-20T12:00:00Z'));

  const list = await triggers.listRecent('a1', 10);
  assert.deepEqual(list.map(x => x.type), ['TAKE_PROFIT', 'STOP_LOSS']);
});
```

- [ ] **Step 3: Chạy test, xác nhận thất bại**

```bash
node --test packages/db/tests/triggers_repo.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/repositories/triggers.js'`.

- [ ] **Step 4: Cài đặt `packages/db/src/repositories/triggers.js`**

```js
import { assertAgentScope } from './_guard.js';

export function createTriggersRepo(client) {
  async function getLastFired(agentId, symbol, type) {
    const id = assertAgentScope(agentId, 'getLastFired');
    const { rows } = await client.query(
      `SELECT fired_at FROM trigger_log
       WHERE agent_id = $1 AND symbol = $2 AND type = $3`, [id, symbol, type]);
    return rows[0] ? rows[0].fired_at : null;
  }

  async function recordFired(agentId, symbol, type, firedAt) {
    const id = assertAgentScope(agentId, 'recordFired');
    await client.query(
      `INSERT INTO trigger_log (agent_id, symbol, type, fired_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (agent_id, symbol, type) DO UPDATE SET fired_at = EXCLUDED.fired_at`,
      [id, symbol, type, firedAt]);
  }

  async function listRecent(agentId, limit = 50) {
    const id = assertAgentScope(agentId, 'listRecent');
    const { rows } = await client.query(
      `SELECT symbol, type, fired_at AS "firedAt" FROM trigger_log
       WHERE agent_id = $1 ORDER BY fired_at DESC LIMIT $2`, [id, limit]);
    return rows;
  }

  return { getLastFired, recordFired, listRecent };
}
```

- [ ] **Step 5: Thêm export vào `packages/db/src/index.js`**

```js
export { createTriggersRepo } from './repositories/triggers.js';
```

- [ ] **Step 6: Chạy migration và test**

```bash
npm run migrate
node packages/db/src/migrate.js --test
node --test packages/db/tests/triggers_repo.test.js
node --test packages/db/tests/triggers_repo.test.js
npm test
```

Kỳ vọng: 7/7 cả hai lần; toàn suite xanh.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(db): trigger log for watchdog debounce"
```

---

### Task 3: Watchdog

**Files:**
- Create: `packages/agent-runtime/src/orchestrator/events.js`
- Create: `packages/agent-runtime/src/orchestrator/watchdog.js`
- Test: `packages/agent-runtime/tests/watchdog.test.js`

**Interfaces:**
- Consumes: `evaluateTriggers`, `isDebounced` (Task 1); `createTriggersRepo` (Task 2); `loadPortfolio` (Phase 2); `createRunner`, `createEngine` (Phase 2); `createEventsRepo` (Phase 1)
- Produces:
  - `EVENTS` — hằng tên sự kiện
  - `createWatchdog({ repos, engine, runner, logger })` → `{ tick({ agentId, agentDef, now, tradeDate, tickPriceMap, refPriceMap, newsSentimentMap }) → TickResult }`
  - `TickResult = { checked, fired: Trigger[], debounced: Trigger[], woken: number, results: [] }`
  - **Bất biến quan trọng:** `woken === 0` thì `runner.runOnce` KHÔNG được gọi lần nào.

- [ ] **Step 1: Viết test thất bại**

`packages/agent-runtime/tests/watchdog.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo, createTradingRepo, createTriggersRepo, createEventsRepo } from '@stockagents/db';
import { createWatchdog } from '../src/orchestrator/watchdog.js';
import { createEngine } from '../src/sim/engine.js';
import { applyBuy, refreshSellable } from '../src/sim/portfolio.js';
import { DEFAULT_RISK } from '../src/sim/guardrails.js';

const silent = { info() {}, warn() {}, error() {} };
let client, repos, engine;
const TABLES = ['trigger_log', 'position_lots', 'fills', 'orders', 'trade_outcomes',
  'trades', 'positions', 'portfolio_snapshot', 'metrics_daily', 'event_log', 'agents', 'universe'];

const agentDef = { id: 'a1', personaPrompt: 'p', riskConfig: DEFAULT_RISK };

function countingRunner(decisions = []) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async runOnce() {
      calls++;
      return { status: 'OK', decisions, invalid: [], results: [] };
    },
  };
}

const base = (over = {}) => ({
  agentId: 'a1', agentDef,
  now: new Date('2026-07-23T10:00:00+07:00'),
  tradeDate: '2026-07-23',
  tickPriceMap: new Map([['HOSE:FPT', 101_000]]),
  refPriceMap: new Map([['HOSE:FPT', 100_000]]),
  newsSentimentMap: new Map(),
  ...over,
});

before(async () => {
  client = await withTestDb();
  repos = {
    agents: createAgentsRepo(client), trading: createTradingRepo(client),
    triggers: createTriggersRepo(client), events: createEventsRepo(client),
  };
  engine = createEngine({ repos, logger: silent });
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE')`);
  await repos.agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
  await applyBuy({
    repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000,
    priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20',
    exitPlan: { takeProfitPct: 8, stopLossPct: -4, trailingPct: 3 },
  });
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });
});
after(async () => { await client.close(); });

test('KHÔNG gọi LLM khi giá đi ngang — đây là lý do exitPlan tồn tại', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  const r = await wd.tick(base());

  assert.equal(r.checked, 1);
  assert.deepEqual(r.fired, []);
  assert.equal(r.woken, 0);
  assert.equal(runner.calls, 0, 'giá đi ngang mà vẫn gọi LLM là hỏng cả cơ chế');
});

test('chạm chốt lời thì đánh thức agent đúng một lần', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  const r = await wd.tick(base({ tickPriceMap: new Map([['HOSE:FPT', 108_000]]) }));

  assert.equal(r.woken, 1);
  assert.equal(runner.calls, 1);
  assert.ok(r.fired.some(t => t.type === 'TAKE_PROFIT'));
});

test('chống rung: nhịp thứ hai trong 30 phút không đánh thức lại', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });
  const hot = new Map([['HOSE:FPT', 108_000]]);

  await wd.tick(base({ tickPriceMap: hot, now: new Date('2026-07-23T10:00:00+07:00') }));
  const second = await wd.tick(base({ tickPriceMap: hot, now: new Date('2026-07-23T10:20:00+07:00') }));

  assert.equal(runner.calls, 1, 'lần hai phải bị chặn');
  assert.ok(second.debounced.some(t => t.type === 'TAKE_PROFIT'));
  assert.equal(second.woken, 0);
});

test('quá 30 phút thì được đánh thức lại', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });
  const hot = new Map([['HOSE:FPT', 108_000]]);

  await wd.tick(base({ tickPriceMap: hot, now: new Date('2026-07-23T10:00:00+07:00') }));
  await wd.tick(base({ tickPriceMap: hot, now: new Date('2026-07-23T10:31:00+07:00') }));

  assert.equal(runner.calls, 2);
});

test('đỉnh giá được cập nhật để trailing hoạt động ở nhịp sau', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  // Giá lên 120.000 -> đỉnh phải được ghi nhận (chưa chạm trailing)
  await wd.tick(base({ tickPriceMap: new Map([['HOSE:FPT', 120_000]]) }));
  const pos = await repos.trading.getPosition('a1', 'HOSE:FPT');
  assert.equal(pos.peakPriceVnd, 120_000);

  // Tụt về 116.000 = -3,33% từ đỉnh -> TRAILING nổ
  const r = await wd.tick(base({
    tickPriceMap: new Map([['HOSE:FPT', 116_000]]),
    now: new Date('2026-07-23T11:00:00+07:00'),
  }));
  assert.ok(r.fired.some(t => t.type === 'TRAILING'));
});

test('đỉnh giá không bao giờ đi xuống', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  await wd.tick(base({ tickPriceMap: new Map([['HOSE:FPT', 120_000]]) }));
  await wd.tick(base({ tickPriceMap: new Map([['HOSE:FPT', 90_000]]),
                       now: new Date('2026-07-23T11:00:00+07:00') }));

  const pos = await repos.trading.getPosition('a1', 'HOSE:FPT');
  assert.equal(pos.peakPriceVnd, 120_000);
});

test('tin xấu mạnh đánh thức agent dù giá chưa chạm ngưỡng nào', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  const r = await wd.tick(base({ newsSentimentMap: new Map([['HOSE:FPT', -0.8]]) }));
  assert.ok(r.fired.some(t => t.type === 'NEWS_ALERT'));
  assert.equal(runner.calls, 1);
});

test('mỗi lần trigger nổ đều phát sự kiện đọc được', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  await wd.tick(base({ tickPriceMap: new Map([['HOSE:FPT', 108_000]]) }));

  const events = await repos.events.getEventsSince(0, 50);
  const fired = events.find(e => e.type === 'trigger.fired');
  assert.ok(fired, 'phải có sự kiện trigger.fired');
  assert.equal(fired.agentId, 'a1');
  assert.equal(fired.payload.triggerType, 'TAKE_PROFIT');
});

test('không có vị thế thì không kiểm tra gì và không gọi LLM', async () => {
  await resetTables(client, ['position_lots', 'positions']);
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  const r = await wd.tick(base({ tickPriceMap: new Map([['HOSE:FPT', 108_000]]) }));
  assert.equal(r.checked, 0);
  assert.equal(runner.calls, 0);
});

test('thiếu giá cho mã đang giữ thì bỏ qua mã đó, không đoán bừa', async () => {
  const runner = countingRunner();
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  const r = await wd.tick(base({ tickPriceMap: new Map() }));
  assert.equal(r.checked, 0);
  assert.equal(runner.calls, 0);
});

test('runner ném lỗi không làm sập watchdog', async () => {
  const runner = { async runOnce() { throw new Error('rate limit'); } };
  const wd = createWatchdog({ repos, engine, runner, logger: silent });

  await assert.doesNotReject(() => wd.tick(base({ tickPriceMap: new Map([['HOSE:FPT', 108_000]]) })));
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/agent-runtime/tests/watchdog.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/orchestrator/watchdog.js'`.

- [ ] **Step 3: Cài đặt `packages/agent-runtime/src/orchestrator/events.js`**

```js
/**
 * Tên sự kiện phát ra qua event_log. Phase 4 (dashboard SSE) đọc đúng
 * những tên này, nên chúng là hợp đồng, không phải chuỗi tùy hứng.
 */
export const EVENTS = Object.freeze({
  SESSION_STATE: 'session.state',
  AGENT_STARTED: 'agent.started',
  AGENT_DECIDED: 'agent.decided',
  AGENT_SKIPPED: 'agent.skipped',
  ORDER_PLACED: 'order.placed',
  ORDER_FILLED: 'order.filled',
  ORDER_REJECTED: 'order.rejected',
  TRIGGER_FIRED: 'trigger.fired',
  POSITION_MARKED: 'position.marked',
  METRICS_UPDATED: 'metrics.updated',
});
```

- [ ] **Step 4: Cài đặt `packages/agent-runtime/src/orchestrator/watchdog.js`**

```js
import { evaluateTriggers, isDebounced, DEBOUNCE_MINUTES } from './triggers.js';
import { loadPortfolio } from '../sim/portfolio.js';
import { EVENTS } from './events.js';

/**
 * Watchdog — vòng theo dõi 5 phút.
 *
 * BẤT BIẾN QUAN TRỌNG NHẤT: nếu không trigger nào nổ, KHÔNG lời gọi LLM nào
 * được phát ra. Cả cơ chế exitPlan tồn tại để chi phí token tỉ lệ với số
 * SỰ KIỆN chứ không phải số PHÚT (spec §6.3). Có test riêng canh điều này.
 */
export function createWatchdog({ repos, engine, runner, logger = console }) {

  function heldDaysOf(openedAt, now) {
    if (!openedAt) return 0;
    const ms = now.getTime() - new Date(openedAt).getTime();
    return Math.floor(ms / 86_400_000);
  }

  async function tick({ agentId, agentDef, now, tradeDate, tickPriceMap, refPriceMap, newsSentimentMap }) {
    const positions = await repos.trading.getOpenPositions(agentId);
    const result = { checked: 0, fired: [], debounced: [], woken: 0, results: [] };

    const wakeFor = [];

    for (const p of positions) {
      const lastPriceVnd = tickPriceMap.get(p.symbol);
      if (!Number.isFinite(lastPriceVnd)) {
        logger.warn(`[watchdog] ${agentId} ${p.symbol}: không có giá, bỏ qua nhịp này`);
        continue;
      }
      result.checked++;

      // Đỉnh giá chỉ đi lên. Trailing đo từ đỉnh nên nếu đỉnh tụt theo giá
      // thì trailing sẽ không bao giờ nổ.
      const peak = Math.max(lastPriceVnd, p.peakPriceVnd ?? 0);
      if (peak !== p.peakPriceVnd) {
        await repos.trading.upsertPosition(agentId, {
          symbol: p.symbol, qtyTotal: p.qtyTotal, qtySellable: p.qtySellable,
          avgCostVnd: p.avgCostVnd, exitPlan: p.exitPlan, peakPriceVnd: peak,
        });
      }

      const fired = evaluateTriggers({
        position: { ...p, peakPriceVnd: peak },
        lastPriceVnd,
        now,
        heldDays: heldDaysOf(p.openedAt, now),
        newsSentiment: newsSentimentMap?.get(p.symbol),
      });

      for (const t of fired) {
        const lastFiredAt = await repos.triggers.getLastFired(agentId, t.symbol, t.type);
        if (isDebounced({ lastFiredAt, now, minutes: DEBOUNCE_MINUTES })) {
          result.debounced.push(t);
          continue;
        }
        await repos.triggers.recordFired(agentId, t.symbol, t.type, now);
        await repos.events.appendEvent({
          type: EVENTS.TRIGGER_FIRED, agentId, symbol: t.symbol,
          payload: { triggerType: t.type, reason: t.reason, unrealizedPct: t.unrealizedPct },
        });
        result.fired.push(t);
        if (!wakeFor.includes(t.symbol)) wakeFor.push(t.symbol);
      }
    }

    // Một lời gọi LLM cho cả nhịp, mang theo mọi trigger vừa nổ — không phải
    // một lời gọi cho mỗi trigger.
    if (wakeFor.length > 0) {
      result.woken = 1;
      try {
        await repos.events.appendEvent({
          type: EVENTS.AGENT_STARTED, agentId,
          payload: { trigger: 'EXIT_THRESHOLD', symbols: wakeFor },
        });
        // NAV và lãi/lỗ ngày phải là số THẬT: guardrail chặn-lỗ-ngày đọc chúng.
        // Truyền 0 sẽ vô hiệu hoá cơ chế an toàn đó trên chính đường mà phần
        // lớn lệnh bán đi qua.
        const portfolio = await loadPortfolio({ repos, agentId, priceMap: tickPriceMap });
        const prevSnap = await repos.agents.getPreviousSnapshot(agentId, tradeDate);
        const dayPnl = prevSnap ? portfolio.nav - prevSnap.nav : 0;

        const run = await runner.runOnce({
          agentId, agentDef,
          context: { trigger: 'EXIT_THRESHOLD', firedTriggers: result.fired },
          ctx: {
            tradeDate, refPriceMap, tickPriceMap,
            nav: portfolio.nav, dayPnl, risk: agentDef.riskConfig,
          },
        });
        result.results = run.results ?? [];
      } catch (err) {
        // Watchdog phải sống sót qua lỗi provider — nó còn phải chạy tiếp
        // suốt phiên cho các vị thế khác.
        logger.error(`[watchdog] ${agentId} lỗi khi đánh thức agent: ${err.message}`);
        await repos.events.appendEvent({
          type: EVENTS.AGENT_SKIPPED, agentId, payload: { error: err.message },
        });
      }
    }

    return result;
  }

  return { tick };
}
```

- [ ] **Step 5: Chạy test hai lần và toàn suite**

```bash
node --test packages/agent-runtime/tests/watchdog.test.js
node --test packages/agent-runtime/tests/watchdog.test.js
npm test
```

Kỳ vọng: 11/11 cả hai lần; toàn suite xanh.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-runtime
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(orchestrator): watchdog with peak tracking, debounce and event emission"
```

---

### Task 4: Máy trạng thái phiên

**Files:**
- Create: `packages/agent-runtime/src/orchestrator/session.js`
- Test: `packages/agent-runtime/tests/orchestrator.test.js`

**Interfaces:**
- Consumes: `createWatchdog` (Task 3), `runSession` (Phase 2), `createOpsRepo` (Phase 1), `EVENTS` (Task 3)
- Produces:
  - `SESSION_STATES = ['PRE_OPEN','OPEN','WATCHING','CLOSING','IDLE']`
  - `createOrchestrator({ client, repos, logger })` → `{ runDay({ agentId, agentDef, tradeDate, provider, ticks, stalenessMinutes }) → DayResult }`
  - `ticks` = mảng `{ at: Date, prices: Map<symbol, tvPrice> }` — mô phỏng các nhịp trong phiên
  - `DayResult = { state, tradeDate, open, watch: TickResult[], close }`
  - PRE_OPEN từ chối mở phiên khi `session_state` là `DATA_STALE` hoặc dữ liệu quá cũ

- [ ] **Step 1: Viết test thất bại**

`packages/agent-runtime/tests/orchestrator.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo, createOpsRepo, createEventsRepo } from '@stockagents/db';
import { createOrchestrator } from '../src/orchestrator/session.js';
import { createStubProvider } from '../src/llm/stub.js';
import { DEFAULT_RISK } from '../src/sim/guardrails.js';

const silent = { info() {}, warn() {}, error() {} };
let client, agentsRepo, opsRepo, eventsRepo;
const TABLES = ['trigger_log', 'position_lots', 'fills', 'orders', 'trade_outcomes',
  'trades', 'positions', 'portfolio_snapshot', 'metrics_daily', 'event_log',
  'indicator_snapshot', 'quote_tick', 'ohlcv_daily', 'session_state', 'agents', 'universe'];

const agentDef = {
  id: 'a1', name: 'A1', provider: 'stub', model: 'stub',
  personaPrompt: 'p', initialCapital: 1_000_000_000, riskConfig: DEFAULT_RISK,
};

const buyThenHold = () => createStubProvider({ script: [
  [{ action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
     limitPriceVnd: null, confidence: 0.7, reason: 'mở vị thế',
     exitPlan: { takeProfitPct: 8, stopLossPct: -4 } }],
  [{ action: 'HOLD', symbol: 'HOSE:FPT', reason: 'giữ tiếp', confidence: 0.5 }],
] });

before(async () => {
  client = await withTestDb();
  agentsRepo = createAgentsRepo(client);
  opsRepo = createOpsRepo(client);
  eventsRepo = createEventsRepo(client);
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await client.query(`INSERT INTO universe (symbol, exchange, sector) VALUES ('HOSE:FPT','HOSE','Công nghệ')`);
  await client.query(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume)
                      VALUES ('HOSE:FPT','2026-07-22', 99, 101, 98, 100, 1000000)`);
  await client.query(`INSERT INTO quote_tick (symbol, price, volume) VALUES ('HOSE:FPT', 100, 5000)`);
  await client.query(`INSERT INTO indicator_snapshot (symbol, payload) VALUES ('HOSE:FPT', '{"rsi14":55}')`);
  await opsRepo.setSessionState('2026-07-23', 'DATA_READY', { dataCapturedAt: new Date() });
  await agentsRepo.upsertMany([agentDef]);
});
after(async () => { await client.close(); });

test('phiên đầy đủ: mở cửa mua, theo dõi, chốt phiên', async () => {
  const orch = createOrchestrator({ client, logger: silent });

  const r = await orch.runDay({
    agentId: 'a1', agentDef, tradeDate: '2026-07-23', provider: buyThenHold(),
    ticks: [
      { at: new Date('2026-07-23T09:30:00+07:00'), prices: new Map([['HOSE:FPT', 101]]) },
      { at: new Date('2026-07-23T10:00:00+07:00'), prices: new Map([['HOSE:FPT', 102]]) },
    ],
  });

  assert.equal(r.state, 'IDLE');
  assert.equal(r.open.results[0].status, 'FILLED');
  assert.equal(r.watch.length, 2);
  assert.ok(r.close.nav > 0);
});

test('DATA_STALE thì KHÔNG mở phiên — thà không trade còn hơn trade mù', async () => {
  await opsRepo.setSessionState('2026-07-23', 'DATA_STALE', { note: 'mất CDP' });
  const orch = createOrchestrator({ client, logger: silent });

  const r = await orch.runDay({
    agentId: 'a1', agentDef, tradeDate: '2026-07-23', provider: buyThenHold(), ticks: [],
  });

  assert.equal(r.state, 'PRE_OPEN');
  assert.equal(r.open, null);
  assert.equal(r.close, null);
});

test('DATA_PARTIAL vẫn mở phiên nhưng có cảnh báo trong sự kiện', async () => {
  await opsRepo.setSessionState('2026-07-23', 'DATA_PARTIAL', { note: '1/30 mã lỗi' });
  const orch = createOrchestrator({ client, logger: silent });

  const r = await orch.runDay({
    agentId: 'a1', agentDef, tradeDate: '2026-07-23', provider: buyThenHold(), ticks: [],
  });

  assert.equal(r.state, 'IDLE');
  const events = await eventsRepo.getEventsSince(0, 50);
  const st = events.filter(e => e.type === 'session.state');
  assert.ok(st.some(e => e.payload.dataState === 'DATA_PARTIAL'));
});

test('chạm chốt lời trong phiên thì watchdog đánh thức agent', async () => {
  const provider = createStubProvider({ script: [
    [{ action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
       limitPriceVnd: null, confidence: 0.7, reason: 'mở vị thế',
       exitPlan: { takeProfitPct: 8, stopLossPct: -4 } }],
    [{ action: 'SELL', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
       limitPriceVnd: null, confidence: 0.9, reason: 'chốt lời theo kế hoạch' }],
  ] });
  const orch = createOrchestrator({ client, logger: silent });

  const r = await orch.runDay({
    agentId: 'a1', agentDef, tradeDate: '2026-07-23', provider,
    ticks: [
      { at: new Date('2026-07-23T10:00:00+07:00'), prices: new Map([['HOSE:FPT', 110]]) },
    ],
  });

  assert.equal(r.watch[0].woken, 1);
  assert.ok(r.watch[0].fired.some(t => t.type === 'TAKE_PROFIT'));
});

test('phát sự kiện chuyển trạng thái theo đúng thứ tự', async () => {
  const orch = createOrchestrator({ client, logger: silent });
  await orch.runDay({
    agentId: 'a1', agentDef, tradeDate: '2026-07-23', provider: buyThenHold(), ticks: [],
  });

  const events = await eventsRepo.getEventsSince(0, 50);
  const states = events.filter(e => e.type === 'session.state').map(e => e.payload.state);
  assert.deepEqual(states, ['PRE_OPEN', 'OPEN', 'WATCHING', 'CLOSING', 'IDLE']);
});

test('chạy lại cùng ngày không nhân đôi snapshot', async () => {
  const orch = createOrchestrator({ client, logger: silent });
  await orch.runDay({ agentId: 'a1', agentDef, tradeDate: '2026-07-23', provider: buyThenHold(), ticks: [] });
  await orch.runDay({ agentId: 'a1', agentDef, tradeDate: '2026-07-23', provider: buyThenHold(), ticks: [] });

  const { rows } = await client.query(
    `SELECT count(*)::int n FROM portfolio_snapshot WHERE agent_id='a1' AND snap_date='2026-07-23'`);
  assert.equal(rows[0].n, 1);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/agent-runtime/tests/orchestrator.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/orchestrator/session.js'`.

- [ ] **Step 3: Cài đặt `packages/agent-runtime/src/orchestrator/session.js`**

```js
import {
  createAgentsRepo, createTradingRepo, createTriggersRepo,
  createEventsRepo, createOpsRepo, createUniverseRepo, createMarketRepo,
} from '@stockagents/db';
import { toVnd } from '../sim/vn_rules.js';
import { createEngine } from '../sim/engine.js';
import { createRunner } from '../agents/runner.js';
import { createWatchdog } from './watchdog.js';
import { runSession } from '../session.js';
import { closeSession } from '../sim/pnl.js';
import { EVENTS } from './events.js';

export const SESSION_STATES = Object.freeze(
  ['PRE_OPEN', 'OPEN', 'WATCHING', 'CLOSING', 'IDLE']);

// Trạng thái dữ liệu cho phép mở phiên. DATA_STALE thì không —
// thà không giao dịch còn hơn giao dịch mù (spec §4).
const TRADEABLE_DATA_STATES = new Set(['DATA_READY', 'DATA_PARTIAL']);

export function createOrchestrator({ client, logger = console }) {
  const repos = {
    agents: createAgentsRepo(client),
    trading: createTradingRepo(client),
    triggers: createTriggersRepo(client),
    events: createEventsRepo(client),
    ops: createOpsRepo(client),
    universe: createUniverseRepo(client),
    market: createMarketRepo(client),
  };

  async function emitState(state, agentId, extra = {}) {
    await repos.events.appendEvent({
      type: EVENTS.SESSION_STATE, agentId, payload: { state, ...extra },
    });
  }

  async function runDay({ agentId, agentDef, tradeDate, provider, ticks = [] }) {
    // ---- PRE_OPEN: kiểm tra dữ liệu trước khi cho ai giao dịch ----
    const sessionState = await repos.ops.getSessionState(tradeDate);
    const dataState = sessionState?.state ?? 'DATA_STALE';
    await emitState('PRE_OPEN', agentId, { dataState });

    if (!TRADEABLE_DATA_STATES.has(dataState)) {
      logger.warn(`[orchestrator] ${agentId} ${tradeDate}: dữ liệu ${dataState}, không mở phiên`);
      return { state: 'PRE_OPEN', tradeDate, dataState, open: null, watch: [], close: null };
    }
    if (dataState === 'DATA_PARTIAL') {
      logger.warn(`[orchestrator] ${agentId} ${tradeDate}: dữ liệu chỉ đủ một phần`);
    }

    // ---- OPEN: agent quyết định mở vị thế ----
    await emitState('OPEN', agentId, { dataState });
    const open = await runSession({ client, agentId, tradeDate, provider, agentDef, logger });

    // ---- WATCHING: vòng theo dõi, chỉ đánh thức LLM khi chạm ngưỡng ----
    await emitState('WATCHING', agentId, { tickCount: ticks.length });
    const engine = createEngine({ repos, logger });
    const runner = createRunner({ repos, engine, provider, logger });
    const watchdog = createWatchdog({ repos, engine, runner, logger });

    const universe = await repos.universe.listActive();
    const refPriceMap = await buildRefPriceMap(client, universe);
    const watch = [];

    for (const tick of ticks) {
      const tickPriceMap = new Map();
      for (const [symbol, tvPrice] of tick.prices) tickPriceMap.set(symbol, toVnd(tvPrice));

      watch.push(await watchdog.tick({
        agentId, agentDef, now: tick.at, tradeDate,
        tickPriceMap, refPriceMap, newsSentimentMap: tick.newsSentiment ?? new Map(),
      }));
    }

    // ---- CLOSING: mark-to-market bằng giá cuối cùng thấy được ----
    await emitState('CLOSING', agentId);
    const finalPrices = ticks.length > 0
      ? mapToVnd(ticks[ticks.length - 1].prices)
      : await buildTickPriceMap(client, universe);
    const close = await closeSession({ repos, agentId, tradeDate, priceMap: finalPrices });

    await repos.events.appendEvent({
      type: EVENTS.METRICS_UPDATED, agentId,
      payload: { nav: close.nav, dayPnl: close.dayPnl, totalReturnPct: close.totalReturnPct },
    });

    await emitState('IDLE', agentId);
    return { state: 'IDLE', tradeDate, dataState, open, watch, close };
  }

  return { runDay };
}

function mapToVnd(prices) {
  const out = new Map();
  for (const [symbol, tvPrice] of prices) out.set(symbol, toVnd(tvPrice));
  return out;
}

async function buildRefPriceMap(client, universe) {
  const symbols = universe.map(u => u.symbol);
  const map = new Map();
  if (symbols.length === 0) return map;
  const { rows } = await client.query(
    `SELECT DISTINCT ON (symbol) symbol, close FROM ohlcv_daily
     WHERE symbol = ANY($1) ORDER BY symbol, trade_date DESC`, [symbols]);
  for (const r of rows) map.set(r.symbol, toVnd(Number(r.close)));
  return map;
}

async function buildTickPriceMap(client, universe) {
  const symbols = universe.map(u => u.symbol);
  const map = new Map();
  if (symbols.length === 0) return map;
  const { rows } = await client.query(
    `SELECT DISTINCT ON (symbol) symbol, price FROM quote_tick
     WHERE symbol = ANY($1) ORDER BY symbol, ts DESC`, [symbols]);
  for (const r of rows) map.set(r.symbol, toVnd(Number(r.price)));
  return map;
}
```

- [ ] **Step 4: Chạy test hai lần và toàn suite**

```bash
node --test packages/agent-runtime/tests/orchestrator.test.js
node --test packages/agent-runtime/tests/orchestrator.test.js
npm test
```

Kỳ vọng: 6/6 cả hai lần; toàn suite xanh.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(orchestrator): session state machine with data-freshness gate"
```

---

### Task 5: CLI chạy ngày mô phỏng + tài liệu

**Files:**
- Create: `packages/agent-runtime/src/cli_day.js`
- Modify: root `package.json` (script `sim:day`)
- Modify: `README.md`

**Interfaces:**
- Consumes: `createOrchestrator` (Task 4), `loadAgentDefs`, `createProvider` (Phase 2)
- Produces: lệnh `npm run sim:day -- --agent <id> --date YYYY-MM-DD [--stub]`

- [ ] **Step 1: Cài đặt `packages/agent-runtime/src/cli_day.js`**

```js
import { parseArgs } from 'node:util';
import { createClient, loadConfig, createAgentsRepo } from '@stockagents/db';
import { loadAgentDefs } from './agents/registry.js';
import { createProvider } from './llm/provider.js';
import { createOrchestrator } from './orchestrator/session.js';

const { values } = parseArgs({
  options: {
    agent: { type: 'string' },
    date: { type: 'string' },
    stub: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (!values.agent || !values.date) {
  console.error('Dùng: npm run sim:day -- --agent <id> --date YYYY-MM-DD [--stub]');
  process.exit(1);
}

const cfg = loadConfig();
const client = createClient(cfg.databaseUrl);

try {
  const defs = await loadAgentDefs();
  const def = defs.find(d => d.id === values.agent);
  if (!def) {
    console.error(`Không tìm thấy agent '${values.agent}'. Có sẵn: ${defs.map(d => d.id).join(', ')}`);
    process.exit(1);
  }

  await createAgentsRepo(client).upsertMany([def]);

  const provider = createProvider({
    provider: values.stub ? 'stub' : def.provider, model: def.model,
  });

  // Phát lại các tick đã thu trong ngày. Watchdog chỉ đánh thức LLM khi
  // chạm ngưỡng, nên số tick nhiều không đồng nghĩa tốn nhiều token.
  const { rows } = await client.query(
    `SELECT symbol, price, ts FROM quote_tick
     WHERE ts::date = $1::date ORDER BY ts`, [values.date]);

  const byTs = new Map();
  for (const r of rows) {
    const key = r.ts.toISOString();
    if (!byTs.has(key)) byTs.set(key, { at: r.ts, prices: new Map() });
    byTs.get(key).prices.set(r.symbol, Number(r.price));
  }
  const ticks = [...byTs.values()];

  const orch = createOrchestrator({ client });
  const r = await orch.runDay({
    agentId: def.id, agentDef: def, tradeDate: values.date, provider, ticks,
  });

  console.log(JSON.stringify({
    state: r.state,
    dataState: r.dataState,
    tickCount: ticks.length,
    openFilled: r.open?.results.filter(x => x.status === 'FILLED').length ?? 0,
    triggersFired: r.watch.flatMap(w => w.fired).map(t => `${t.type} ${t.symbol}`),
    llmWakeups: r.watch.reduce((s, w) => s + w.woken, 0),
    close: r.close,
  }, null, 2));
} catch (err) {
  console.error(err.stack || err.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
```

- [ ] **Step 2: Thêm script vào root `package.json`**

```json
    "sim:day": "node packages/agent-runtime/src/cli_day.js",
```

- [ ] **Step 3: Chạy toàn suite**

```bash
npm test
```

Kỳ vọng: toàn suite xanh.

- [ ] **Step 4: Kiểm chứng end-to-end**

Nạp dữ liệu mẫu rồi chạy:

```bash
npm run sim:day -- --agent claude_value --date 2026-07-23 --stub
```

Kỳ vọng: JSON in ra có `state`, `triggersFired`, `llmWakeups`. Nếu chưa có `session_state` cho ngày đó thì `state` là `PRE_OPEN` và không có lệnh nào — đó là hành vi đúng. Ghi lại kết quả thực tế.

- [ ] **Step 5: Cập nhật `README.md`**

```markdown
## Phase 3 — Orchestrator & Watchdog

Chạy trọn một ngày mô phỏng: mở phiên, theo dõi, tự thoát vị thế.

```bash
npm run sim:day -- --agent claude_value --date 2026-07-23 --stub
```

**Cơ chế đánh thức:** agent khai `exitPlan` ngay lúc mua. Watchdog so sánh số
học mỗi nhịp tick — **không gọi LLM**. Chỉ khi chạm ngưỡng mới đánh thức agent,
nên chi phí token tỉ lệ với số *sự kiện*, không phải số *phút*.

| Trigger | Điều kiện |
|---|---|
| `TAKE_PROFIT` | lãi chạm `takeProfitPct` |
| `STOP_LOSS` | lỗ chạm `stopLossPct` |
| `TRAILING` | tụt `trailingPct` từ **đỉnh** kể từ lúc mua |
| `TIME_STOP` | giữ đủ `timeStopDays` phiên |
| `NEWS_ALERT` | sentiment tin ≤ −0,5 |
| `EOD_REVIEW` | từ 14:30 giờ VN |

Mỗi vị thế chịu chống rung 30 phút cho **cùng** loại trigger.

**Cổng dữ liệu:** phiên chỉ mở khi `session_state` là `DATA_READY` hoặc
`DATA_PARTIAL`. `DATA_STALE` thì không mở — thà không giao dịch còn hơn
giao dịch mù.
```

- [ ] **Step 6: Commit**

```bash
git add packages/agent-runtime package.json README.md
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(orchestrator): simulated-day CLI and docs"
```

---

## Điều kiện hoàn thành Phase 3

- [ ] `npm test` xanh (Phase 1+2: 220 test + Phase 3: ~42 test mới)
- [ ] Mỗi file test mới chạy riêng được và chạy hai lần liên tiếp vẫn xanh
- [ ] **Giá đi ngang qua nhiều nhịp tick → `runner.runOnce` được gọi 0 lần.** Đây là bất biến quan trọng nhất của Phase này.
- [ ] Chạm chốt lời → đánh thức đúng một lần; nhịp thứ hai trong 30 phút bị chặn
- [ ] Đỉnh giá chỉ đi lên, và trailing đo từ đỉnh chứ không từ giá vốn
- [ ] `DATA_STALE` → không mở phiên, không lệnh nào
- [ ] `event_log` có đủ `session.state`, `trigger.fired`, `metrics.updated`

## Sửa phát sinh khi thực thi

**Giá mở phiên lấy nhầm tick cuối ngày.** `runSession` luôn đọc tick MỚI NHẤT
từ `quote_tick` — đúng khi chạy trực tiếp lúc 09:15, nhưng sai khi phát lại
cả ngày: agent mua ở giá đóng cửa rồi mọi nhịp sau đều trông như đang lỗ, và
`STOP_LOSS` nổ liên tục. Câu chuyện nghe hợp lý mà hoàn toàn sai.

Sửa: `runSession` nhận thêm `priceOverride`; `runDay` truyền giá của tick ĐẦU
tiên trong ngày. Một test cũ từng xanh **nhờ chính lỗi này** (nó chỉ có một
tick nên giá mở cửa vô tình lấy từ DB) đã được viết lại cho đúng mô hình.

## Ghi chú cho Phase 4

- `EVENTS` trong `orchestrator/events.js` là hợp đồng cho dashboard SSE. Đừng đổi tên chuỗi mà không sửa cả hai phía.
- `trade_outcomes` vẫn chưa được ghi; win rate chưa tính được. Cần ghép lệnh mua–bán thành round-trip.
- `orders.status` vẫn chưa có `PARTIALLY_FILLED`.
