# Phase 2 — Simulation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Một agent giao dịch giả lập trọn phiên trên dữ liệu Phase 1 — tuân thủ đầy đủ luật thị trường VN, có PnL đúng, chạy được end-to-end mà chưa cần API key nào.

**Architecture:** Package mới `packages/agent-runtime`. Luật thị trường là **hàm thuần** (không DB, không LLM) nên test được bằng bảng case. Simulation Engine là trọng tài duy nhất: agent chỉ *đề xuất*, engine kiểm tra và có quyền từ chối. Lệnh khớp bằng cách đối chiếu với `quote_tick` mà data-service đã thu — cùng nguồn dữ liệu Phase 3 watchdog sẽ dùng. Lớp LLM có stub tất định để toàn bộ Phase 2 chạy và test được không cần API key.

**Tech Stack:** Node.js 20/22 (ESM), PostgreSQL 18, `pg`, `node --test`. Không thêm dependency nào.

## Global Constraints

- JavaScript ESM only (`"type": "module"`). Không TypeScript, không build step.
- Node.js >= 20.20. Test runner: `node --test` qua `npm test` (script `scripts/run-tests.mjs`). Không thêm jest/vitest/mocha.
- **Chạy test bằng `npm test`.** Không gọi `node --test` với glob hoặc thư mục — cách truyền tham số khác nhau giữa Node 20 và 22 và một trong hai cho suite rỗng báo xanh.
- **Mọi hàm repository chạm bảng có `agent_id` bắt buộc gọi `assertAgentScope(agentId, fnName)` đầu tiên.** Cô lập agent phải cưỡng chế bằng code (spec §3.2).
- **LLM không giữ quy tắc an toàn** (spec §3.3). Giới hạn vị thế, tiền mặt, T+2.5, biên độ nằm trong engine. Engine validate đầu ra LLM *trước khi* nó chạm dữ liệu.
- Không sửa gì trong `tradingview_mcp/`. Không import `tradingview-mcp` ở package này.
- Tiền tệ `NUMERIC(20,2)`, không dùng float cho tiền trong DB.
- Ngày giao dịch theo `Asia/Ho_Chi_Minh`.
- Mọi file test phải **tự chứa**: chạy riêng được, chạy hai lần liên tiếp vẫn xanh.
- Commit theo Conventional Commits. Tác giả: `git -c user.email=claudeai07@vhec.vn -c user.name="Claude"`.

---

## Quyết định thiết kế đã chốt

| Hạng mục | Quyết định |
|---|---|
| Mô hình khớp lệnh | Đối chiếu `quote_tick` trong phiên. LIMIT khớp khi giá chạm; MARKET khớp tick kế tiếp; ATC khớp giá đóng cửa |
| Agent đầu tiên | Xây trọn lớp agent với **LLM stub tất định**. Cắm `ANTHROPIC_API_KEY` vào là chạy thật |
| pgvector | Hoãn tới Phase 6 |

## ĐƠN VỊ GIÁ — đọc kỹ trước khi viết dòng code nào

TradingView hiển thị cổ phiếu VN theo **nghìn đồng**: FPT là `118.5`, không phải `118500`. Nhưng `agents.initial_capital` là `1000000000` (1 tỷ **VND**).

Trộn hai đơn vị này sẽ cho ra danh mục sai 1000 lần mà **không lỗi nào bung ra** — đúng họ lỗi đã hành Phase 1 bốn lần.

Quy ước của Phase 2:

- **Engine tính toàn bộ bằng VND.** Mọi số tiền trong `orders`, `fills`, `positions`, `portfolio_snapshot` là VND.
- `ohlcv_daily` và `quote_tick` lưu **nguyên giá trị TradingView trả về** (Phase 1 đã thế, không đổi).
- Chuyển đổi xảy ra ở **đúng một chỗ**: `toVnd(price)` trong `vn_rules.js`, nhân với `PRICE_SCALE`.
- `PRICE_SCALE` mặc định `1000`, đọc từ env `PRICE_SCALE` để đổi được mà không sửa code.

**Chưa ai xác minh giả định này với dữ liệu thật** — `ohlcv_daily` đang rỗng vì TradingView chưa từng chạy. Nên Task 1 kèm một hàm kiểm tra tính hợp lý (`assertPlausibleVndPrice`) chặn giá nằm ngoài khoảng 1.000–10.000.000 VND. Nếu đơn vị sai, nó vỡ to tiếng ngay lệnh đầu tiên thay vì âm thầm.

---

## File Structure

| File | Trách nhiệm |
|---|---|
| `packages/agent-runtime/package.json` | Manifest |
| `src/sim/vn_rules.js` | Hàm thuần: đơn vị giá, lô chẵn, biên độ, bước giá, ngày T+2 |
| `src/sim/fees.js` | Hàm thuần: phí mua/bán, thuế, tiền thực nhận/thực trả |
| `src/sim/guardrails.js` | Hàm thuần: giới hạn vị thế, tiền mặt, lỗ ngày (spec §7.2) |
| `src/sim/portfolio.js` | Dựng trạng thái danh mục từ DB: tiền mặt, vị thế, lô, NAV |
| `src/sim/engine.js` | Vòng đời lệnh: validate → đặt → khớp theo tick → ghi |
| `src/sim/pnl.js` | PnL thực hiện/tạm tính, snapshot cuối phiên |
| `src/agents/registry.js` | Nạp định nghĩa agent từ `config/agents.json` |
| `src/agents/context.js` | Dựng context đưa cho agent |
| `src/agents/runner.js` | Gọi agent → validate quyết định → nộp engine |
| `src/llm/provider.js` | Interface chung + chọn provider |
| `src/llm/stub.js` | Provider tất định, không cần mạng |
| `src/llm/anthropic.js` | Provider Claude thật |
| `src/llm/decision_schema.js` | Schema + validate quyết định |
| `src/session.js` | Chạy trọn một phiên giả lập |
| `src/cli.js` | Chạy tay: `npm run sim:session` |
| `packages/db/src/repositories/trading.js` | orders, fills, positions, lots (agent-scoped) |
| `packages/db/src/repositories/agents.js` | agents, portfolio_snapshot (agent-scoped) |
| `config/agents.json` | Định nghĩa agent |

---

### Task 1: Package scaffolding + luật thị trường VN

**Files:**
- Create: `packages/agent-runtime/package.json`
- Create: `packages/agent-runtime/src/sim/vn_rules.js`
- Test: `packages/agent-runtime/tests/vn_rules.test.js`
- Modify: root `package.json` (thêm script `sim:session`)

**Interfaces:**
- Consumes: không (task đầu Phase 2)
- Produces:
  - `PRICE_SCALE: number`
  - `toVnd(price) → number` — nhân `PRICE_SCALE`, làm tròn về đồng
  - `assertPlausibleVndPrice(vnd, context) → number` — throw nếu ngoài 1.000–10.000.000
  - `parseSymbol(symbol) → { exchange, ticker }`
  - `BAND_PCT: { HOSE: 7, HNX: 10, UPCOM: 15 }`
  - `priceBand(refVnd, exchange) → { floor, ceiling }` — đã làm tròn về bước giá
  - `tickSize(vnd) → number` — 10 / 50 / 100
  - `roundToTick(vnd) → number`
  - `normalizeQty(qty) → number` — làm tròn xuống bội 100
  - `settlementDate(tradeDate, holidays?) → 'YYYY-MM-DD'` — T+2 phiên
  - `LOT_SIZE: 100`

- [ ] **Step 1: Tạo `packages/agent-runtime/package.json`**

```json
{
  "name": "@stockagents/agent-runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/session.js",
  "dependencies": {
    "@stockagents/db": "*"
  }
}
```

Rồi `npm install` ở thư mục gốc để workspace nhận package mới.

- [ ] **Step 2: Viết test thất bại**

`packages/agent-runtime/tests/vn_rules.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE_SCALE, LOT_SIZE, toVnd, assertPlausibleVndPrice, parseSymbol,
  BAND_PCT, priceBand, tickSize, roundToTick, normalizeQty, settlementDate,
} from '../src/sim/vn_rules.js';

test('toVnd đổi giá TradingView (nghìn đồng) sang VND', () => {
  assert.equal(PRICE_SCALE, 1000);
  assert.equal(toVnd(118.5), 118500);
  assert.equal(toVnd(9.99), 9990);
});

test('toVnd làm tròn về đồng nguyên', () => {
  assert.equal(toVnd(118.5049), 118505);
  assert.equal(Number.isInteger(toVnd(61.237)), true);
});

test('toVnd từ chối đầu vào không phải số hữu hạn', () => {
  assert.throws(() => toVnd(NaN), /toVnd/);
  assert.throws(() => toVnd(undefined), /toVnd/);
});

test('assertPlausibleVndPrice chặn giá sai đơn vị', () => {
  // Quên nhân PRICE_SCALE -> 118.5 VND, vô lý cho cổ phiếu VN
  assert.throws(() => assertPlausibleVndPrice(118.5, 'HOSE:FPT'), /HOSE:FPT/);
  // Nhân hai lần -> 118 triệu, cũng vô lý
  assert.throws(() => assertPlausibleVndPrice(118500000, 'HOSE:FPT'), /HOSE:FPT/);
  assert.equal(assertPlausibleVndPrice(118500, 'HOSE:FPT'), 118500);
});

test('parseSymbol tách sàn và mã', () => {
  assert.deepEqual(parseSymbol('HOSE:FPT'), { exchange: 'HOSE', ticker: 'FPT' });
  assert.deepEqual(parseSymbol('HNX:SHS'), { exchange: 'HNX', ticker: 'SHS' });
});

test('parseSymbol từ chối sàn lạ', () => {
  assert.throws(() => parseSymbol('NASDAQ:AAPL'), /NASDAQ/);
  assert.throws(() => parseSymbol('FPT'), /FPT/);
});

test('tickSize theo ba bậc của HOSE', () => {
  assert.equal(tickSize(9990), 10);
  assert.equal(tickSize(10000), 50);
  assert.equal(tickSize(49950), 50);
  assert.equal(tickSize(50000), 100);
  assert.equal(tickSize(118500), 100);
});

test('roundToTick làm tròn về bước giá hợp lệ', () => {
  assert.equal(roundToTick(118530), 118500);
  assert.equal(roundToTick(118560), 118600);
  assert.equal(roundToTick(9993), 9990);
  assert.equal(roundToTick(25030), 25050);
});

test('priceBand HOSE ±7% và đã về bước giá', () => {
  const { floor, ceiling } = priceBand(100000, 'HOSE');
  assert.equal(ceiling, 107000);
  assert.equal(floor, 93000);
  assert.equal(ceiling % tickSize(ceiling), 0);
  assert.equal(floor % tickSize(floor), 0);
});

test('priceBand khác nhau theo sàn', () => {
  assert.equal(BAND_PCT.HOSE, 7);
  assert.equal(BAND_PCT.HNX, 10);
  assert.equal(BAND_PCT.UPCOM, 15);
  assert.equal(priceBand(100000, 'HNX').ceiling, 110000);
  assert.equal(priceBand(100000, 'UPCOM').ceiling, 115000);
});

test('priceBand làm tròn VÀO TRONG biên, không ra ngoài', () => {
  // 7% của 23050 = 24663.5 -> bước giá 50 -> phải là 24650, không phải 24700
  const { ceiling, floor } = priceBand(23050, 'HOSE');
  assert.ok(ceiling <= 23050 * 1.07, `trần ${ceiling} vượt biên độ`);
  assert.ok(floor >= 23050 * 0.93, `sàn ${floor} vượt biên độ`);
});

test('normalizeQty làm tròn xuống bội 100', () => {
  assert.equal(LOT_SIZE, 100);
  assert.equal(normalizeQty(1000), 1000);
  assert.equal(normalizeQty(1099), 1000);
  assert.equal(normalizeQty(99), 0);
  assert.equal(normalizeQty(0), 0);
});

test('normalizeQty từ chối số âm và không nguyên', () => {
  assert.throws(() => normalizeQty(-100), /normalizeQty/);
  assert.throws(() => normalizeQty(100.5), /normalizeQty/);
});

test('settlementDate là T+2 phiên, nhảy qua cuối tuần', () => {
  // Thứ Hai 2026-07-20 -> Thứ Tư 2026-07-22
  assert.equal(settlementDate('2026-07-20'), '2026-07-22');
  // Thứ Năm 2026-07-23 -> Thứ Hai 2026-07-27 (bỏ T7, CN)
  assert.equal(settlementDate('2026-07-23'), '2026-07-27');
  // Thứ Sáu 2026-07-24 -> Thứ Ba 2026-07-28
  assert.equal(settlementDate('2026-07-24'), '2026-07-28');
});

test('settlementDate bỏ qua ngày lễ được truyền vào', () => {
  // Nghỉ 2026-07-22 -> T+2 từ thứ Hai đẩy sang thứ Năm
  assert.equal(settlementDate('2026-07-20', ['2026-07-22']), '2026-07-23');
});

test('settlementDate từ chối ngày sai định dạng', () => {
  assert.throws(() => settlementDate('20/07/2026'), /settlementDate/);
});
```

- [ ] **Step 3: Chạy test, xác nhận thất bại**

```bash
node --test packages/agent-runtime/tests/vn_rules.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/sim/vn_rules.js'`.

- [ ] **Step 4: Cài đặt `packages/agent-runtime/src/sim/vn_rules.js`**

```js
/**
 * Luật thị trường chứng khoán Việt Nam — TOÀN BỘ là hàm thuần.
 * Không DB, không LLM, không I/O. Đây là tầng duy nhất biết luật, và nó
 * test được bằng bảng case mà không cần dựng gì.
 */

// TradingView báo giá cổ phiếu VN theo NGHÌN ĐỒNG (FPT = 118.5).
// Engine tính bằng VND. Đây là chỗ DUY NHẤT chuyển đổi.
export const PRICE_SCALE = Number(process.env.PRICE_SCALE ?? 1000);

export const LOT_SIZE = 100;

export const BAND_PCT = Object.freeze({ HOSE: 7, HNX: 10, UPCOM: 15 });

// Khoảng giá hợp lý cho một cổ phiếu VN, tính bằng VND.
// Dùng để bắt lỗi SAI ĐƠN VỊ — thứ không tạo ra exception nào tự nhiên.
const MIN_PLAUSIBLE_VND = 1_000;
const MAX_PLAUSIBLE_VND = 10_000_000;

export function toVnd(price) {
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    throw new Error(`toVnd: cần số hữu hạn, nhận được: ${price}`);
  }
  return Math.round(price * PRICE_SCALE);
}

/**
 * Chặn giá sai đơn vị. Quên nhân PRICE_SCALE cho ra ~118 VND; nhân hai lần
 * cho ra ~118 triệu. Cả hai đều là số hợp lệ về mặt kiểu dữ liệu và sẽ
 * chảy êm qua toàn hệ thống nếu không có hàng rào này.
 */
export function assertPlausibleVndPrice(vnd, context = '') {
  if (typeof vnd !== 'number' || !Number.isFinite(vnd)) {
    throw new Error(`assertPlausibleVndPrice: ${context} giá không hợp lệ: ${vnd}`);
  }
  if (vnd < MIN_PLAUSIBLE_VND || vnd > MAX_PLAUSIBLE_VND) {
    throw new Error(
      `assertPlausibleVndPrice: ${context} giá ${vnd} VND nằm ngoài khoảng hợp lý ` +
      `(${MIN_PLAUSIBLE_VND}–${MAX_PLAUSIBLE_VND}). Nhiều khả năng sai đơn vị: ` +
      `PRICE_SCALE hiện là ${PRICE_SCALE}.`,
    );
  }
  return vnd;
}

export function parseSymbol(symbol) {
  const parts = String(symbol).split(':');
  if (parts.length !== 2 || !BAND_PCT[parts[0]]) {
    throw new Error(
      `parseSymbol: '${symbol}' không hợp lệ. Cần dạng SAN:MA với sàn thuộc ` +
      `${Object.keys(BAND_PCT).join('/')}.`,
    );
  }
  return { exchange: parts[0], ticker: parts[1] };
}

export function tickSize(vnd) {
  if (vnd < 10_000) return 10;
  if (vnd < 50_000) return 50;
  return 100;
}

export function roundToTick(vnd) {
  const step = tickSize(vnd);
  return Math.round(vnd / step) * step;
}

/**
 * Biên độ dao động. Làm tròn VÀO TRONG: trần làm tròn xuống, sàn làm tròn lên.
 * Làm tròn ra ngoài sẽ sinh ra lệnh mà sàn thật từ chối.
 */
export function priceBand(refVnd, exchange) {
  const pct = BAND_PCT[exchange];
  if (!pct) throw new Error(`priceBand: sàn không hợp lệ: ${exchange}`);

  // Nhân TRƯỚC rồi mới chia, để tránh sai số dấu phẩy động.
  // `100000 * 1.15` cho 114999.99999999999, và làm tròn xuống bước giá
  // biến nó thành 114900 — lệch một bước giá ở đúng chỗ nhạy cảm nhất.
  const rawCeiling = (refVnd * (100 + pct)) / 100;
  const rawFloor = (refVnd * (100 - pct)) / 100;

  const ceiling = Math.floor(rawCeiling / tickSize(rawCeiling)) * tickSize(rawCeiling);
  const floor = Math.ceil(rawFloor / tickSize(rawFloor)) * tickSize(rawFloor);

  return { floor, ceiling };
}

export function normalizeQty(qty) {
  if (!Number.isInteger(qty) || qty < 0) {
    throw new Error(`normalizeQty: cần số nguyên không âm, nhận được: ${qty}`);
  }
  return Math.floor(qty / LOT_SIZE) * LOT_SIZE;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * T+2.5 của VN: mua ngày T thì T+2 mới bán được.
 * Đếm theo PHIÊN (bỏ cuối tuần và ngày lễ), không phải ngày lịch.
 */
export function settlementDate(tradeDate, holidays = []) {
  if (!ISO_DATE.test(tradeDate)) {
    throw new Error(`settlementDate: cần định dạng YYYY-MM-DD, nhận được: ${tradeDate}`);
  }
  const skip = new Set(holidays);
  const d = new Date(`${tradeDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`settlementDate: ngày không hợp lệ: ${tradeDate}`);
  }

  let sessions = 0;
  while (sessions < 2) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6 || skip.has(iso)) continue;
    sessions++;
  }
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 5: Chạy test, xác nhận thành công**

```bash
node --test packages/agent-runtime/tests/vn_rules.test.js
```

Kỳ vọng: PASS — 15 test.

- [ ] **Step 6: Chạy file này hai lần liên tiếp và chạy toàn suite**

```bash
node --test packages/agent-runtime/tests/vn_rules.test.js
npm test
```

Kỳ vọng: 15/15 cả hai lần chạy riêng; `npm test` xanh và số file test tăng thêm 1.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-runtime package.json package-lock.json
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(sim): Vietnamese market rules as pure functions"
```

---

### Task 2: Phí và thuế

**Files:**
- Create: `packages/agent-runtime/src/sim/fees.js`
- Test: `packages/agent-runtime/tests/fees.test.js`

**Interfaces:**
- Consumes: không
- Produces:
  - `FEE_RATE: 0.0015`, `SELL_TAX_RATE: 0.001`
  - `buyCost({ priceVnd, qty }) → { gross, fee, tax, total }` — `total` là tiền phải chi
  - `sellProceeds({ priceVnd, qty }) → { gross, fee, tax, net }` — `net` là tiền thực nhận
  - Mọi giá trị là VND làm tròn về đồng nguyên

- [ ] **Step 1: Viết test thất bại**

`packages/agent-runtime/tests/fees.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEE_RATE, SELL_TAX_RATE, buyCost, sellProceeds } from '../src/sim/fees.js';

test('tỷ lệ phí và thuế đúng quy định VN', () => {
  assert.equal(FEE_RATE, 0.0015);
  assert.equal(SELL_TAX_RATE, 0.001);
});

test('buyCost: phí 0,15%, không thuế, tổng chi lớn hơn giá trị', () => {
  const r = buyCost({ priceVnd: 100000, qty: 1000 });
  assert.equal(r.gross, 100_000_000);
  assert.equal(r.fee, 150_000);
  assert.equal(r.tax, 0);
  assert.equal(r.total, 100_150_000);
});

test('sellProceeds: phí 0,15% + thuế 0,1%, tiền nhận nhỏ hơn giá trị', () => {
  const r = sellProceeds({ priceVnd: 100000, qty: 1000 });
  assert.equal(r.gross, 100_000_000);
  assert.equal(r.fee, 150_000);
  assert.equal(r.tax, 100_000);
  assert.equal(r.net, 99_750_000);
});

test('mua rồi bán ngay tại cùng giá là LỖ đúng bằng phí và thuế', () => {
  const buy = buyCost({ priceVnd: 50000, qty: 1000 });
  const sell = sellProceeds({ priceVnd: 50000, qty: 1000 });
  assert.equal(buy.total - sell.net, buy.fee + sell.fee + sell.tax);
  assert.ok(sell.net < buy.total, 'lướt sóng không phí là ảo tưởng');
});

test('mọi giá trị là số nguyên đồng', () => {
  const r = buyCost({ priceVnd: 33333, qty: 700 });
  for (const [k, v] of Object.entries(r)) {
    assert.ok(Number.isInteger(v), `${k} = ${v} không phải số nguyên`);
  }
});

test('từ chối đầu vào không hợp lệ', () => {
  assert.throws(() => buyCost({ priceVnd: NaN, qty: 100 }), /buyCost/);
  assert.throws(() => buyCost({ priceVnd: 100000, qty: 0 }), /buyCost/);
  assert.throws(() => sellProceeds({ priceVnd: -1, qty: 100 }), /sellProceeds/);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/agent-runtime/tests/fees.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/sim/fees.js'`.

- [ ] **Step 3: Cài đặt `packages/agent-runtime/src/sim/fees.js`**

```js
/** Phí giao dịch và thuế theo quy định VN. Hàm thuần, đơn vị VND. */

export const FEE_RATE = 0.0015;      // 0,15% cả mua lẫn bán
export const SELL_TAX_RATE = 0.001;  // 0,1% thuế TNCN, chỉ khi bán

function validate(fnName, priceVnd, qty) {
  if (typeof priceVnd !== 'number' || !Number.isFinite(priceVnd) || priceVnd <= 0) {
    throw new Error(`${fnName}: priceVnd phải là số dương hữu hạn, nhận được: ${priceVnd}`);
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error(`${fnName}: qty phải là số nguyên dương, nhận được: ${qty}`);
  }
}

export function buyCost({ priceVnd, qty }) {
  validate('buyCost', priceVnd, qty);
  const gross = Math.round(priceVnd * qty);
  const fee = Math.round(gross * FEE_RATE);
  return { gross, fee, tax: 0, total: gross + fee };
}

export function sellProceeds({ priceVnd, qty }) {
  validate('sellProceeds', priceVnd, qty);
  const gross = Math.round(priceVnd * qty);
  const fee = Math.round(gross * FEE_RATE);
  const tax = Math.round(gross * SELL_TAX_RATE);
  return { gross, fee, tax, net: gross - fee - tax };
}
```

- [ ] **Step 4: Chạy test, xác nhận thành công**

```bash
node --test packages/agent-runtime/tests/fees.test.js
npm test
```

Kỳ vọng: 6/6 và toàn suite xanh.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(sim): VN trading fees and personal income tax"
```

---

### Task 3: Repository giao dịch (agent-scoped)

> **Sửa sau khi thực thi:** bản đầu của plan lưu tiền mặt vào snapshot mới nhất
> để khỏi thêm cột. Sai: snapshot mới nhất chính là mốc `1970-01-01` chứa vốn
> ban đầu, nên **mỗi lệnh mua lại ghi đè chính mốc so sánh PnL ngày** — dayPnl
> thành một con số vô nghĩa. Tiền mặt là *trạng thái*, snapshot là *lịch sử*.
> Migration `006_agent_cash.sql` thêm `agents.cash_vnd`; `getCash`/`setCash`
> đọc ghi cột đó.


**Files:**
- Create: `packages/db/src/repositories/trading.js`
- Create: `packages/db/src/repositories/agents.js`
- Modify: `packages/db/src/index.js` (thêm 2 export)
- Test: `packages/db/tests/trading.test.js`

**Interfaces:**
- Consumes: `createClient()`, `assertAgentScope(agentId, fnName)`
- Produces:
  - `createAgentsRepo(client)` → `{ upsertMany(agents), get(agentId), listActive(), getCash(agentId), setCash(agentId, vnd), saveSnapshot(agentId, snapDate, {cash, marketValue, nav, dayPnl}), getSnapshot(agentId, snapDate) }`
  - `createTradingRepo(client)` → `{ insertOrder(agentId, o), rejectOrder(agentId, orderId, reason), fillOrder(agentId, orderId, {qty, priceVnd, fee, tax}), listOpenOrders(agentId), getOpenPositions(agentId), getPosition(agentId, symbol), upsertPosition(agentId, pos), addLot(positionId, {qty, costVnd, sellableFrom}), listLots(positionId), consumeLots(positionId, qty), closePosition(agentId, positionId), insertTrade(agentId, t), listTrades(agentId, limit) }`
  - `createAgentsRepo` còn có `getPreviousSnapshot(agentId, beforeDate)` — **được thêm ở Task 7**, không phải task này.
  - Mọi hàm nhận `agentId` gọi `assertAgentScope` đầu tiên.
  - `Order = { symbol, side, qty, orderType, limitPriceVnd }`; `insertOrder` trả `{ id }`.

- [ ] **Step 1: Viết test thất bại**

`packages/db/tests/trading.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo } from '../src/repositories/agents.js';
import { createTradingRepo } from '../src/repositories/trading.js';

let client, agents, trading;

before(async () => {
  client = await withTestDb();
  agents = createAgentsRepo(client);
  trading = createTradingRepo(client);
});
beforeEach(async () => {
  await resetTables(client, [
    'position_lots', 'fills', 'orders', 'trade_outcomes', 'trades',
    'positions', 'portfolio_snapshot', 'metrics_daily', 'agents', 'universe',
  ]);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE'),('HOSE:VCB','HOSE')`);
  await agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1000000000 },
    { id: 'a2', name: 'A2', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1000000000 },
  ]);
});
after(async () => { await client.close(); });

test('mọi hàm agent-scoped từ chối khi thiếu agentId', async () => {
  await assert.rejects(() => trading.getOpenPositions(), /agentId/);
  await assert.rejects(() => trading.listTrades(''), /agentId/);
  await assert.rejects(() => agents.getCash(null), /agentId/);
});

test('insertOrder ghi lệnh và trả id', async () => {
  const { id } = await trading.insertOrder('a1', {
    symbol: 'HOSE:FPT', side: 'BUY', qty: 1000, orderType: 'LIMIT', limitPriceVnd: 118500,
  });
  assert.ok(id > 0);
  const open = await trading.listOpenOrders('a1');
  assert.equal(open.length, 1);
  assert.equal(open[0].symbol, 'HOSE:FPT');
});

test('listOpenOrders của agent này không thấy lệnh của agent kia', async () => {
  await trading.insertOrder('a1', { symbol: 'HOSE:FPT', side: 'BUY', qty: 100, orderType: 'MARKET', limitPriceVnd: null });
  await trading.insertOrder('a2', { symbol: 'HOSE:VCB', side: 'BUY', qty: 100, orderType: 'MARKET', limitPriceVnd: null });

  const a1 = await trading.listOpenOrders('a1');
  assert.deepEqual(a1.map(o => o.symbol), ['HOSE:FPT']);
});

test('rejectOrder đổi trạng thái và lưu lý do', async () => {
  const { id } = await trading.insertOrder('a1', { symbol: 'HOSE:FPT', side: 'BUY', qty: 100, orderType: 'MARKET', limitPriceVnd: null });
  await trading.rejectOrder('a1', id, 'không đủ tiền mặt');

  const { rows } = await client.query('SELECT status, reject_reason FROM orders WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'REJECTED');
  assert.equal(rows[0].reject_reason, 'không đủ tiền mặt');
  assert.equal((await trading.listOpenOrders('a1')).length, 0);
});

test('fillOrder ghi fill kèm agent_id khớp order cha', async () => {
  const { id } = await trading.insertOrder('a1', { symbol: 'HOSE:FPT', side: 'BUY', qty: 1000, orderType: 'MARKET', limitPriceVnd: null });
  await trading.fillOrder('a1', id, { qty: 1000, priceVnd: 118500, fee: 177750, tax: 0 });

  const { rows } = await client.query('SELECT agent_id, qty, price FROM fills WHERE order_id = $1', [id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent_id, 'a1');
  assert.equal(Number(rows[0].price), 118500);
});

test('vị thế và lô lưu đúng ngày bán được', async () => {
  const pos = await trading.upsertPosition('a1', {
    symbol: 'HOSE:FPT', qtyTotal: 1000, qtySellable: 0, avgCostVnd: 118500,
  });
  await trading.addLot(pos.id, { qty: 1000, costVnd: 118500, sellableFrom: '2026-07-22' });

  const lots = await trading.listLots(pos.id);
  assert.equal(lots.length, 1);
  assert.equal(lots[0].sellableFrom, '2026-07-22');
});

test('getOpenPositions chỉ trả vị thế chưa đóng', async () => {
  const pos = await trading.upsertPosition('a1', { symbol: 'HOSE:FPT', qtyTotal: 1000, qtySellable: 0, avgCostVnd: 118500 });
  assert.equal((await trading.getOpenPositions('a1')).length, 1);

  await trading.closePosition('a1', pos.id);
  assert.equal((await trading.getOpenPositions('a1')).length, 0);
});

test('tiền mặt khởi tạo bằng initial_capital và cập nhật được', async () => {
  assert.equal(await agents.getCash('a1'), 1000000000);
  await agents.setCash('a1', 880000000);
  assert.equal(await agents.getCash('a1'), 880000000);
  assert.equal(await agents.getCash('a2'), 1000000000, 'không được đụng agent khác');
});

test('saveSnapshot ghi và ghi đè cùng ngày', async () => {
  await agents.saveSnapshot('a1', '2026-07-20', { cash: 900000000, marketValue: 120000000, nav: 1020000000, dayPnl: 20000000 });
  await agents.saveSnapshot('a1', '2026-07-20', { cash: 880000000, marketValue: 150000000, nav: 1030000000, dayPnl: 30000000 });

  const s = await agents.getSnapshot('a1', '2026-07-20');
  assert.equal(s.nav, 1030000000);
});

test('insertTrade lưu reasoning và đọc lại được theo agent', async () => {
  await trading.insertTrade('a1', {
    symbol: 'HOSE:FPT', action: 'BUY', priceVnd: 118500, qty: 1000,
    reason: 'vượt MA20 với khối lượng lớn', confidence: 0.72, trigger: 'SESSION_OPEN',
  });
  const list = await trading.listTrades('a1', 10);
  assert.equal(list.length, 1);
  assert.match(list[0].reason, /MA20/);
  assert.equal((await trading.listTrades('a2', 10)).length, 0);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/db/tests/trading.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/repositories/agents.js'`.

- [ ] **Step 3: Cài đặt `packages/db/src/repositories/agents.js`**

```js
import { assertAgentScope } from './_guard.js';

const num = (v) => (v === null || v === undefined ? null : Number(v));

export function createAgentsRepo(client) {
  async function upsertMany(list) {
    for (const a of list) {
      await client.query(
        `INSERT INTO agents (id, name, provider, model, persona_prompt, initial_capital, risk_config, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, provider = EXCLUDED.provider, model = EXCLUDED.model,
           persona_prompt = EXCLUDED.persona_prompt, risk_config = EXCLUDED.risk_config`,
        [a.id, a.name, a.provider, a.model, a.personaPrompt, a.initialCapital, a.riskConfig ?? {}],
      );
      // Tiền mặt khởi tạo lưu ở snapshot ngày 'epoch' để không cần bảng riêng.
      await client.query(
        `INSERT INTO portfolio_snapshot (agent_id, snap_date, cash, market_value, nav, day_pnl)
         VALUES ($1, DATE '1970-01-01', $2, 0, $2, 0)
         ON CONFLICT (agent_id, snap_date) DO NOTHING`,
        [a.id, a.initialCapital],
      );
    }
    return list.length;
  }

  async function get(agentId) {
    const id = assertAgentScope(agentId, 'get');
    const { rows } = await client.query(
      `SELECT id, name, provider, model, persona_prompt AS "personaPrompt",
              initial_capital AS "initialCapital", risk_config AS "riskConfig", active
       FROM agents WHERE id = $1`, [id]);
    if (!rows[0]) return null;
    return { ...rows[0], initialCapital: num(rows[0].initialCapital) };
  }

  async function listActive() {
    const { rows } = await client.query(
      `SELECT id FROM agents WHERE active ORDER BY id`);
    return rows.map(r => r.id);
  }

  // Tiền mặt = snapshot mới nhất. Chưa có snapshot nào -> initial_capital.
  async function getCash(agentId) {
    const id = assertAgentScope(agentId, 'getCash');
    const { rows } = await client.query(
      `SELECT cash FROM portfolio_snapshot WHERE agent_id = $1
       ORDER BY snap_date DESC LIMIT 1`, [id]);
    return rows[0] ? num(rows[0].cash) : null;
  }

  async function setCash(agentId, vnd) {
    const id = assertAgentScope(agentId, 'setCash');
    if (!Number.isFinite(vnd)) throw new Error(`setCash: cash không hợp lệ: ${vnd}`);
    const { rows } = await client.query(
      `SELECT snap_date FROM portfolio_snapshot WHERE agent_id = $1
       ORDER BY snap_date DESC LIMIT 1`, [id]);
    await client.query(
      `UPDATE portfolio_snapshot SET cash = $2, nav = $2 + market_value
       WHERE agent_id = $1 AND snap_date = $3`,
      [id, vnd, rows[0].snap_date]);
  }

  async function saveSnapshot(agentId, snapDate, { cash, marketValue, nav, dayPnl }) {
    const id = assertAgentScope(agentId, 'saveSnapshot');
    await client.query(
      `INSERT INTO portfolio_snapshot (agent_id, snap_date, cash, market_value, nav, day_pnl)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (agent_id, snap_date) DO UPDATE SET
         cash = EXCLUDED.cash, market_value = EXCLUDED.market_value,
         nav = EXCLUDED.nav, day_pnl = EXCLUDED.day_pnl`,
      [id, snapDate, cash, marketValue, nav, dayPnl]);
  }

  async function getSnapshot(agentId, snapDate) {
    const id = assertAgentScope(agentId, 'getSnapshot');
    const { rows } = await client.query(
      `SELECT cash, market_value AS "marketValue", nav, day_pnl AS "dayPnl"
       FROM portfolio_snapshot WHERE agent_id = $1 AND snap_date = $2`, [id, snapDate]);
    if (!rows[0]) return null;
    return {
      cash: num(rows[0].cash), marketValue: num(rows[0].marketValue),
      nav: num(rows[0].nav), dayPnl: num(rows[0].dayPnl),
    };
  }

  return { upsertMany, get, listActive, getCash, setCash, saveSnapshot, getSnapshot };
}
```

- [ ] **Step 4: Cài đặt `packages/db/src/repositories/trading.js`**

```js
import { assertAgentScope } from './_guard.js';

const num = (v) => (v === null || v === undefined ? null : Number(v));
const isoDate = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

export function createTradingRepo(client) {
  async function insertOrder(agentId, o) {
    const id = assertAgentScope(agentId, 'insertOrder');
    const { rows } = await client.query(
      `INSERT INTO orders (agent_id, symbol, side, qty, order_type, limit_price, status)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDING') RETURNING id`,
      [id, o.symbol, o.side, o.qty, o.orderType, o.limitPriceVnd ?? null]);
    return { id: rows[0].id };
  }

  async function rejectOrder(agentId, orderId, reason) {
    const id = assertAgentScope(agentId, 'rejectOrder');
    await client.query(
      `UPDATE orders SET status = 'REJECTED', reject_reason = $3
       WHERE id = $2 AND agent_id = $1`, [id, orderId, String(reason).slice(0, 500)]);
  }

  async function fillOrder(agentId, orderId, { qty, priceVnd, fee, tax }) {
    const id = assertAgentScope(agentId, 'fillOrder');
    return client.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO fills (order_id, agent_id, qty, price, fee, tax)
         VALUES ($1,$2,$3,$4,$5,$6)`, [orderId, id, qty, priceVnd, fee, tax]);
      await tx.query(
        `UPDATE orders SET status = 'FILLED' WHERE id = $1 AND agent_id = $2`,
        [orderId, id]);
    });
  }

  async function listOpenOrders(agentId) {
    const id = assertAgentScope(agentId, 'listOpenOrders');
    const { rows } = await client.query(
      `SELECT id, symbol, side, qty, order_type AS "orderType", limit_price AS "limitPriceVnd"
       FROM orders WHERE agent_id = $1 AND status = 'PENDING' ORDER BY id`, [id]);
    return rows.map(r => ({ ...r, limitPriceVnd: num(r.limitPriceVnd) }));
  }

  async function getOpenPositions(agentId) {
    const id = assertAgentScope(agentId, 'getOpenPositions');
    const { rows } = await client.query(
      `SELECT id, symbol, qty_total AS "qtyTotal", qty_sellable AS "qtySellable",
              avg_cost AS "avgCostVnd", exit_plan AS "exitPlan", peak_price AS "peakPriceVnd",
              opened_at AS "openedAt"
       FROM positions WHERE agent_id = $1 AND closed_at IS NULL ORDER BY symbol`, [id]);
    return rows.map(r => ({ ...r, avgCostVnd: num(r.avgCostVnd), peakPriceVnd: num(r.peakPriceVnd) }));
  }

  async function getPosition(agentId, symbol) {
    const id = assertAgentScope(agentId, 'getPosition');
    const all = await getOpenPositions(id);
    return all.find(p => p.symbol === symbol) ?? null;
  }

  async function upsertPosition(agentId, pos) {
    const id = assertAgentScope(agentId, 'upsertPosition');
    const { rows } = await client.query(
      `INSERT INTO positions (agent_id, symbol, qty_total, qty_sellable, avg_cost, exit_plan, peak_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (agent_id, symbol) WHERE closed_at IS NULL DO UPDATE SET
         qty_total = EXCLUDED.qty_total, qty_sellable = EXCLUDED.qty_sellable,
         avg_cost = EXCLUDED.avg_cost, exit_plan = EXCLUDED.exit_plan,
         peak_price = EXCLUDED.peak_price
       RETURNING id`,
      [id, pos.symbol, pos.qtyTotal, pos.qtySellable, pos.avgCostVnd,
       pos.exitPlan ?? {}, pos.peakPriceVnd ?? null]);
    return { id: rows[0].id };
  }

  async function addLot(positionId, { qty, costVnd, sellableFrom }) {
    await client.query(
      `INSERT INTO position_lots (position_id, qty, cost, sellable_from)
       VALUES ($1,$2,$3,$4)`, [positionId, qty, costVnd, sellableFrom]);
  }

  async function listLots(positionId) {
    const { rows } = await client.query(
      `SELECT id, qty, cost, sellable_from FROM position_lots
       WHERE position_id = $1 ORDER BY sellable_from, id`, [positionId]);
    return rows.map(r => ({
      id: r.id, qty: r.qty, costVnd: num(r.cost), sellableFrom: isoDate(r.sellable_from),
    }));
  }

  /**
   * Tiêu lô theo FIFO khi bán. Không làm việc này thì position_lots sẽ lệch
   * vĩnh viễn với positions: bán 400/1000 mà lô vẫn ghi 1000, và lần
   * refreshSellable sau sẽ mở khoá nhiều hơn số thực có.
   */
  async function consumeLots(positionId, qty) {
    let left = qty;
    const lots = await listLots(positionId);
    for (const lot of lots) {
      if (left <= 0) break;
      const take = Math.min(left, lot.qty);
      if (take === lot.qty) {
        await client.query('DELETE FROM position_lots WHERE id = $1', [lot.id]);
      } else {
        await client.query('UPDATE position_lots SET qty = qty - $2 WHERE id = $1', [lot.id, take]);
      }
      left -= take;
    }
    if (left > 0) throw new Error(`consumeLots: thiếu ${left} cp trong các lô của vị thế ${positionId}`);
  }

  async function closePosition(agentId, positionId) {
    const id = assertAgentScope(agentId, 'closePosition');
    await client.query(
      `UPDATE positions SET closed_at = now() WHERE id = $2 AND agent_id = $1`,
      [id, positionId]);
  }

  async function insertTrade(agentId, t) {
    const id = assertAgentScope(agentId, 'insertTrade');
    const { rows } = await client.query(
      `INSERT INTO trades (agent_id, symbol, action, price, qty, reason, confidence, trigger, context_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [id, t.symbol, t.action, t.priceVnd, t.qty, t.reason,
       t.confidence ?? null, t.trigger ?? null, t.contextRef ?? {}]);
    return { id: rows[0].id };
  }

  async function listTrades(agentId, limit = 50) {
    const id = assertAgentScope(agentId, 'listTrades');
    const { rows } = await client.query(
      `SELECT id, symbol, action, price, qty, reason, confidence, trigger,
              decided_at AS "decidedAt"
       FROM trades WHERE agent_id = $1 ORDER BY decided_at DESC, id DESC LIMIT $2`,
      [id, limit]);
    return rows.map(r => ({ ...r, priceVnd: num(r.price), confidence: num(r.confidence) }));
  }

  return {
    insertOrder, rejectOrder, fillOrder, listOpenOrders,
    getOpenPositions, getPosition, upsertPosition, addLot, listLots, consumeLots,
    closePosition, insertTrade, listTrades,
  };
}
```

- [ ] **Step 5: Thêm export vào `packages/db/src/index.js`**

```js
export { createAgentsRepo } from './repositories/agents.js';
export { createTradingRepo } from './repositories/trading.js';
```

- [ ] **Step 6: Chạy test**

```bash
node --test packages/db/tests/trading.test.js
node --test packages/db/tests/trading.test.js
npm test
```

Kỳ vọng: 10/10 cả hai lần chạy riêng; toàn suite xanh.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(db): agent-scoped trading and portfolio repositories"
```

---

### Task 4: Guardrails

**Files:**
- Create: `packages/agent-runtime/src/sim/guardrails.js`
- Test: `packages/agent-runtime/tests/guardrails.test.js`

**Interfaces:**
- Consumes: không (hàm thuần)
- Produces:
  - `DEFAULT_RISK = { maxPositions: 8, maxPositionPctNav: 20, dailyLossLimitPct: 5 }`
  - `checkBuy({ symbol, costVnd, cash, nav, positions, risk }) → { ok: boolean, reason?: string }`
  - `checkSell({ symbol, qty, positions }) → { ok, reason? }`
  - `checkDailyLoss({ dayPnl, nav, risk }) → { ok, reason? }`
  - Không bao giờ throw — luôn trả `{ok:false, reason}` để engine ghi vào `reject_reason`.

- [ ] **Step 1: Viết test thất bại**

`packages/agent-runtime/tests/guardrails.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RISK, checkBuy, checkSell, checkDailyLoss } from '../src/sim/guardrails.js';

const NAV = 1_000_000_000;
const pos = (symbol, qtyTotal, qtySellable = qtyTotal) => ({ symbol, qtyTotal, qtySellable });

test('giá trị rủi ro mặc định đúng spec §7.2', () => {
  assert.deepEqual(DEFAULT_RISK, { maxPositions: 8, maxPositionPctNav: 20, dailyLossLimitPct: 5 });
});

test('checkBuy cho qua khi mọi giới hạn thoả', () => {
  const r = checkBuy({ symbol: 'HOSE:FPT', costVnd: 100_000_000, cash: 500_000_000, nav: NAV, positions: [], risk: DEFAULT_RISK });
  assert.equal(r.ok, true);
});

test('checkBuy chặn khi không đủ tiền mặt — không đòn bẩy', () => {
  const r = checkBuy({ symbol: 'HOSE:FPT', costVnd: 600_000_000, cash: 500_000_000, nav: NAV, positions: [], risk: DEFAULT_RISK });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tiền mặt/);
});

test('checkBuy chặn khi vượt tỷ trọng tối đa một mã', () => {
  // 25% NAV > giới hạn 20%
  const r = checkBuy({ symbol: 'HOSE:FPT', costVnd: 250_000_000, cash: NAV, nav: NAV, positions: [], risk: DEFAULT_RISK });
  assert.equal(r.ok, false);
  assert.match(r.reason, /tỷ trọng/);
});

test('checkBuy chặn khi đã đủ số vị thế tối đa', () => {
  const positions = Array.from({ length: 8 }, (_, i) => pos(`HOSE:S${i}`, 100));
  const r = checkBuy({ symbol: 'HOSE:NEW', costVnd: 10_000_000, cash: NAV, nav: NAV, positions, risk: DEFAULT_RISK });
  assert.equal(r.ok, false);
  assert.match(r.reason, /số vị thế/);
});

test('checkBuy CHO PHÉP mua thêm mã đã có dù đủ số vị thế', () => {
  const positions = Array.from({ length: 8 }, (_, i) => pos(`HOSE:S${i}`, 100));
  const r = checkBuy({ symbol: 'HOSE:S0', costVnd: 10_000_000, cash: NAV, nav: NAV, positions, risk: DEFAULT_RISK });
  assert.equal(r.ok, true, 'mua thêm mã đang giữ không tạo vị thế mới');
});

test('checkSell chặn khi không có vị thế', () => {
  const r = checkSell({ symbol: 'HOSE:FPT', qty: 100, positions: [] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /không có vị thế/);
});

test('checkSell chặn bán quá số lượng bán được — không bán khống', () => {
  const r = checkSell({ symbol: 'HOSE:FPT', qty: 1000, positions: [pos('HOSE:FPT', 1000, 500)] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /T\+2|bán được/);
});

test('checkSell cho qua khi bán trong phần đã về tài khoản', () => {
  const r = checkSell({ symbol: 'HOSE:FPT', qty: 500, positions: [pos('HOSE:FPT', 1000, 500)] });
  assert.equal(r.ok, true);
});

test('checkDailyLoss chặn khi lỗ ngày vượt ngưỡng', () => {
  const r = checkDailyLoss({ dayPnl: -60_000_000, nav: NAV, risk: DEFAULT_RISK });
  assert.equal(r.ok, false);
  assert.match(r.reason, /lỗ trong ngày/);
});

test('checkDailyLoss cho qua khi lỗ chưa tới ngưỡng, và khi đang lãi', () => {
  assert.equal(checkDailyLoss({ dayPnl: -40_000_000, nav: NAV, risk: DEFAULT_RISK }).ok, true);
  assert.equal(checkDailyLoss({ dayPnl: 40_000_000, nav: NAV, risk: DEFAULT_RISK }).ok, true);
});

test('guardrails không bao giờ ném lỗi, kể cả đầu vào rác', () => {
  assert.doesNotThrow(() => checkBuy({ symbol: 'X', costVnd: NaN, cash: null, nav: 0, positions: [], risk: DEFAULT_RISK }));
  const r = checkBuy({ symbol: 'X', costVnd: NaN, cash: null, nav: 0, positions: [], risk: DEFAULT_RISK });
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/agent-runtime/tests/guardrails.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/sim/guardrails.js'`.

- [ ] **Step 3: Cài đặt `packages/agent-runtime/src/sim/guardrails.js`**

```js
/**
 * Hàng rào cứng, nằm NGOÀI tầm với của LLM (spec §7.2, §3.3).
 * Agent chỉ đề xuất; những hàm này là trọng tài.
 *
 * KHÔNG BAO GIỜ ném lỗi — luôn trả { ok, reason } để engine ghi lý do vào
 * orders.reject_reason. Lệnh bị từ chối là dữ liệu học, không phải sự cố.
 */

export const DEFAULT_RISK = Object.freeze({
  maxPositions: 8,
  maxPositionPctNav: 20,
  dailyLossLimitPct: 5,
});

const deny = (reason) => ({ ok: false, reason });
const allow = () => ({ ok: true });

export function checkBuy({ symbol, costVnd, cash, nav, positions, risk = DEFAULT_RISK }) {
  if (!Number.isFinite(costVnd) || costVnd <= 0) return deny(`chi phí không hợp lệ: ${costVnd}`);
  if (!Number.isFinite(cash)) return deny(`tiền mặt không hợp lệ: ${cash}`);
  if (!Number.isFinite(nav) || nav <= 0) return deny(`NAV không hợp lệ: ${nav}`);

  if (costVnd > cash) {
    return deny(`không đủ tiền mặt: cần ${costVnd}, có ${cash}`);
  }

  const pctNav = (costVnd / nav) * 100;
  if (pctNav > risk.maxPositionPctNav) {
    return deny(
      `vượt tỷ trọng tối đa một mã: ${pctNav.toFixed(1)}% > ${risk.maxPositionPctNav}% NAV`);
  }

  const isNewPosition = !positions.some(p => p.symbol === symbol);
  if (isNewPosition && positions.length >= risk.maxPositions) {
    return deny(`đã đạt số vị thế tối đa: ${positions.length}/${risk.maxPositions}`);
  }

  return allow();
}

export function checkSell({ symbol, qty, positions }) {
  const p = positions.find(x => x.symbol === symbol);
  if (!p) return deny(`không có vị thế ${symbol} để bán`);
  if (!Number.isInteger(qty) || qty <= 0) return deny(`khối lượng bán không hợp lệ: ${qty}`);

  if (qty > p.qtySellable) {
    return deny(
      `bán ${qty} vượt số lượng bán được ${p.qtySellable} ` +
      `(đang giữ ${p.qtyTotal}, phần còn lại chưa về tài khoản theo T+2)`);
  }
  return allow();
}

export function checkDailyLoss({ dayPnl, nav, risk = DEFAULT_RISK }) {
  if (!Number.isFinite(dayPnl) || !Number.isFinite(nav) || nav <= 0) return allow();
  const lossPct = (-dayPnl / nav) * 100;
  if (lossPct > risk.dailyLossLimitPct) {
    return deny(
      `lỗ trong ngày ${lossPct.toFixed(1)}% vượt ngưỡng ${risk.dailyLossLimitPct}% — ` +
      `dừng giao dịch phần còn lại của phiên`);
  }
  return allow();
}
```

- [ ] **Step 4: Chạy test**

```bash
node --test packages/agent-runtime/tests/guardrails.test.js
npm test
```

Kỳ vọng: 12/12 và toàn suite xanh.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(sim): hard risk guardrails outside LLM reach"
```

---

### Task 5: Danh mục — dựng trạng thái và cập nhật T+2

**Files:**
- Create: `packages/agent-runtime/src/sim/portfolio.js`
- Test: `packages/agent-runtime/tests/portfolio.test.js`

**Interfaces:**
- Consumes: `createTradingRepo`, `createAgentsRepo` (Task 3); `settlementDate` (Task 1)
- Produces:
  - `loadPortfolio({ repos, agentId, priceMap }) → Portfolio`
    `Portfolio = { agentId, cash, positions: [{symbol, qtyTotal, qtySellable, avgCostVnd, lastPriceVnd, marketValue, unrealizedPct}], marketValue, nav }`
  - `refreshSellable({ repos, agentId, today }) → number` — cập nhật `qty_sellable` từ các lô đã tới ngày, trả về số vị thế đã đổi
  - `applyBuy({ repos, agentId, symbol, qty, priceVnd, cost, tradeDate })` — cập nhật vị thế, lô, tiền mặt
  - `applySell({ repos, agentId, symbol, qty, priceVnd, proceeds })` — giảm vị thế FIFO theo lô, cộng tiền, đóng vị thế nếu hết
  - `priceMap` là `Map<symbol, vndPrice>`

- [ ] **Step 1: Viết test thất bại**

`packages/agent-runtime/tests/portfolio.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo, createTradingRepo } from '@stockagents/db';
import { loadPortfolio, refreshSellable, applyBuy, applySell } from '../src/sim/portfolio.js';

let client, repos;

before(async () => {
  client = await withTestDb();
  repos = { agents: createAgentsRepo(client), trading: createTradingRepo(client) };
});
beforeEach(async () => {
  await resetTables(client, [
    'position_lots', 'fills', 'orders', 'trade_outcomes', 'trades',
    'positions', 'portfolio_snapshot', 'metrics_daily', 'agents', 'universe',
  ]);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE'),('HOSE:VCB','HOSE')`);
  await repos.agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
});
after(async () => { await client.close(); });

test('danh mục rỗng: NAV bằng tiền mặt ban đầu', async () => {
  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map() });
  assert.equal(p.cash, 1_000_000_000);
  assert.equal(p.marketValue, 0);
  assert.equal(p.nav, 1_000_000_000);
  assert.deepEqual(p.positions, []);
});

test('applyBuy trừ tiền, tạo vị thế, và lô CHƯA bán được ngay', async () => {
  await applyBuy({
    repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000,
    priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20',
  });

  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map([['HOSE:FPT', 100_000]]) });
  assert.equal(p.cash, 899_850_000);
  assert.equal(p.positions.length, 1);
  assert.equal(p.positions[0].qtyTotal, 1000);
  assert.equal(p.positions[0].qtySellable, 0, 'T+2: mua hôm nay chưa bán được');
  assert.equal(p.marketValue, 100_000_000);
});

test('giá vốn trung bình tính đúng khi mua thêm', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 120_000, cost: 120_180_000, tradeDate: '2026-07-21' });

  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map([['HOSE:FPT', 120_000]]) });
  assert.equal(p.positions[0].qtyTotal, 2000);
  assert.equal(p.positions[0].avgCostVnd, 110_000);
});

test('refreshSellable mở khoá đúng lô đã tới ngày, giữ lô chưa tới', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 500, priceVnd: 100_000, cost: 50_075_000, tradeDate: '2026-07-24' });

  // 2026-07-20 -> bán được từ 2026-07-22; 2026-07-24 -> từ 2026-07-28
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });

  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map([['HOSE:FPT', 100_000]]) });
  assert.equal(p.positions[0].qtyTotal, 1500);
  assert.equal(p.positions[0].qtySellable, 1000, 'chỉ lô mua 20/07 đã về tài khoản');
});

test('applySell cộng tiền, giảm vị thế, tiêu lô theo FIFO', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });

  await applySell({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 400, priceVnd: 110_000, proceeds: 43_890_000 });

  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map([['HOSE:FPT', 110_000]]) });
  assert.equal(p.positions[0].qtyTotal, 600);
  assert.equal(p.positions[0].qtySellable, 600);
  assert.equal(p.cash, 899_850_000 + 43_890_000);

  // Lô phải co lại theo. Nếu không, refreshSellable sau này sẽ mở khoá 1000
  // trong khi chỉ còn 600 cổ phiếu — và bán khống lọt lưới.
  const lots = await repos.trading.listLots(p.positions[0].id);
  assert.equal(lots.reduce((s, l) => s + l.qty, 0), 600, 'tổng lô phải khớp vị thế');
});

test('bán một phần rồi refreshSellable không mở khoá quá số thực có', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });
  await applySell({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 400, priceVnd: 110_000, proceeds: 43_890_000 });
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });

  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map([['HOSE:FPT', 110_000]]) });
  assert.equal(p.positions[0].qtySellable, 600, 'không được mở khoá quá tồn thực tế');
});

test('bán hết thì vị thế đóng lại, không còn trong danh mục', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });
  await applySell({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 110_000, proceeds: 109_725_000 });

  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map() });
  assert.deepEqual(p.positions, []);
  assert.equal(p.marketValue, 0);
});

test('unrealizedPct tính theo giá vốn', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map([['HOSE:FPT', 108_000]]) });
  assert.equal(p.positions[0].unrealizedPct, 8);
});

test('thiếu giá thị trường thì dùng giá vốn, không cho ra NaN', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map() });
  assert.equal(p.positions[0].lastPriceVnd, 100_000);
  assert.equal(p.positions[0].unrealizedPct, 0);
  assert.ok(Number.isFinite(p.nav));
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/agent-runtime/tests/portfolio.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/sim/portfolio.js'`.

- [ ] **Step 3: Cài đặt `packages/agent-runtime/src/sim/portfolio.js`**

```js
import { settlementDate } from './vn_rules.js';

/**
 * Danh mục dựng từ DB. Đây là tầng duy nhất biết cách T+2 tác động lên
 * số lượng bán được: mỗi lần mua tạo một LÔ có ngày về tài khoản riêng,
 * và qty_sellable là tổng các lô đã tới ngày.
 */

export async function loadPortfolio({ repos, agentId, priceMap }) {
  const cash = await repos.agents.getCash(agentId);
  const raw = await repos.trading.getOpenPositions(agentId);

  const positions = raw.map(p => {
    // Thiếu giá thị trường thì dùng giá vốn — cho ra unrealized 0%, không NaN.
    const lastPriceVnd = priceMap.get(p.symbol) ?? p.avgCostVnd;
    const marketValue = Math.round(lastPriceVnd * p.qtyTotal);
    const unrealizedPct = p.avgCostVnd > 0
      ? Math.round(((lastPriceVnd - p.avgCostVnd) / p.avgCostVnd) * 10000) / 100
      : 0;
    return { ...p, lastPriceVnd, marketValue, unrealizedPct };
  });

  const marketValue = positions.reduce((s, p) => s + p.marketValue, 0);
  return { agentId, cash, positions, marketValue, nav: cash + marketValue };
}

/** Mở khoá các lô đã tới ngày về tài khoản. Trả về số vị thế bị thay đổi. */
export async function refreshSellable({ repos, agentId, today }) {
  const positions = await repos.trading.getOpenPositions(agentId);
  let changed = 0;

  for (const p of positions) {
    const lots = await repos.trading.listLots(p.id);
    const sellable = lots
      .filter(l => l.sellableFrom <= today)
      .reduce((s, l) => s + l.qty, 0);

    if (sellable !== p.qtySellable) {
      await repos.trading.upsertPosition(agentId, {
        symbol: p.symbol, qtyTotal: p.qtyTotal, qtySellable: sellable,
        avgCostVnd: p.avgCostVnd, exitPlan: p.exitPlan, peakPriceVnd: p.peakPriceVnd,
      });
      changed++;
    }
  }
  return changed;
}

export async function applyBuy({ repos, agentId, symbol, qty, priceVnd, cost, tradeDate, exitPlan }) {
  const existing = await repos.trading.getPosition(agentId, symbol);

  const qtyTotal = (existing?.qtyTotal ?? 0) + qty;
  const prevCostTotal = (existing?.avgCostVnd ?? 0) * (existing?.qtyTotal ?? 0);
  const avgCostVnd = Math.round((prevCostTotal + priceVnd * qty) / qtyTotal);

  const { id } = await repos.trading.upsertPosition(agentId, {
    symbol,
    qtyTotal,
    qtySellable: existing?.qtySellable ?? 0,   // lô mới chưa về tài khoản
    avgCostVnd,
    exitPlan: exitPlan ?? existing?.exitPlan ?? {},
    peakPriceVnd: Math.max(priceVnd, existing?.peakPriceVnd ?? 0),
  });

  await repos.trading.addLot(id, {
    qty, costVnd: priceVnd, sellableFrom: settlementDate(tradeDate),
  });

  const cash = await repos.agents.getCash(agentId);
  await repos.agents.setCash(agentId, cash - cost);
}

export async function applySell({ repos, agentId, symbol, qty, priceVnd, proceeds }) {
  const p = await repos.trading.getPosition(agentId, symbol);
  if (!p) throw new Error(`applySell: không có vị thế ${symbol} cho ${agentId}`);

  const remaining = p.qtyTotal - qty;
  if (remaining < 0) throw new Error(`applySell: bán ${qty} vượt tồn ${p.qtyTotal}`);

  // Tiêu lô TRƯỚC khi đổi vị thế: lô và vị thế phải luôn khớp nhau, nếu không
  // refreshSellable sẽ mở khoá nhiều hơn số cổ phiếu thực có.
  await repos.trading.consumeLots(p.id, qty);

  if (remaining === 0) {
    await repos.trading.closePosition(agentId, p.id);
  } else {
    await repos.trading.upsertPosition(agentId, {
      symbol, qtyTotal: remaining, qtySellable: p.qtySellable - qty,
      avgCostVnd: p.avgCostVnd, exitPlan: p.exitPlan, peakPriceVnd: p.peakPriceVnd,
    });
  }

  const cash = await repos.agents.getCash(agentId);
  await repos.agents.setCash(agentId, cash + proceeds);
}
```

- [ ] **Step 4: Chạy test**

```bash
node --test packages/agent-runtime/tests/portfolio.test.js
node --test packages/agent-runtime/tests/portfolio.test.js
npm test
```

Kỳ vọng: 9/9 hai lần; toàn suite xanh.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(sim): portfolio state with T+2 lot settlement"
```

---

### Task 6: Simulation Engine — vòng đời lệnh và khớp theo tick

**Files:**
- Create: `packages/agent-runtime/src/sim/engine.js`
- Test: `packages/agent-runtime/tests/engine.test.js`

**Interfaces:**
- Consumes: mọi thứ từ Task 1, 2, 4, 5
- Produces:
  - `createEngine({ repos, logger, slippagePct })` → `{ submit(agentId, decision, ctx), matchPending(agentId, ctx) }`
  - `decision = { action, symbol, quantity, orderType, limitPriceVnd, reason, confidence, exitPlan }`
  - `ctx = { tradeDate, refPriceMap, tickPriceMap, nav, dayPnl, risk }`
  - `submit` trả `{ status: 'FILLED'|'PENDING'|'REJECTED', orderId, reason?, fillPriceVnd? }`
  - `SLIPPAGE_PCT` mặc định `0.1`

- [ ] **Step 1: Viết test thất bại**

`packages/agent-runtime/tests/engine.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo, createTradingRepo } from '@stockagents/db';
import { createEngine } from '../src/sim/engine.js';
import { loadPortfolio, refreshSellable, applyBuy } from '../src/sim/portfolio.js';
import { DEFAULT_RISK } from '../src/sim/guardrails.js';

const silent = { info() {}, warn() {}, error() {} };
let client, repos, engine;

const ctx = (over = {}) => ({
  tradeDate: '2026-07-20',
  refPriceMap: new Map([['HOSE:FPT', 100_000]]),
  tickPriceMap: new Map([['HOSE:FPT', 100_000]]),
  nav: 1_000_000_000,
  dayPnl: 0,
  risk: DEFAULT_RISK,
  ...over,
});

const buy = (over = {}) => ({
  action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
  limitPriceVnd: null, reason: 'test', confidence: 0.6, exitPlan: {}, ...over,
});

before(async () => {
  client = await withTestDb();
  repos = { agents: createAgentsRepo(client), trading: createTradingRepo(client) };
  engine = createEngine({ repos, logger: silent });
});
beforeEach(async () => {
  await resetTables(client, [
    'position_lots', 'fills', 'orders', 'trade_outcomes', 'trades',
    'positions', 'portfolio_snapshot', 'metrics_daily', 'agents', 'universe',
  ]);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE')`);
  await repos.agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
});
after(async () => { await client.close(); });

test('lệnh MARKET hợp lệ khớp ngay và trừ tiền', async () => {
  const r = await engine.submit('a1', buy(), ctx());
  assert.equal(r.status, 'FILLED');

  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: ctx().tickPriceMap });
  assert.equal(p.positions[0].qtyTotal, 1000);
  assert.ok(p.cash < 1_000_000_000);
});

test('MARKET mua chịu trượt giá bất lợi', async () => {
  const r = await engine.submit('a1', buy(), ctx());
  assert.ok(r.fillPriceVnd > 100_000, `mua phải trượt lên, nhận ${r.fillPriceVnd}`);
});

test('khối lượng lẻ bị làm tròn xuống bội 100', async () => {
  const r = await engine.submit('a1', buy({ quantity: 1099 }), ctx());
  assert.equal(r.status, 'FILLED');
  const { rows } = await client.query(`SELECT qty FROM orders WHERE agent_id='a1'`);
  assert.equal(rows[0].qty, 1000);
});

test('khối lượng dưới một lô bị từ chối', async () => {
  const r = await engine.submit('a1', buy({ quantity: 50 }), ctx());
  assert.equal(r.status, 'REJECTED');
  assert.match(r.reason, /lô chẵn|100/);
});

test('lệnh LIMIT ngoài biên độ bị từ chối và ghi lý do vào DB', async () => {
  const r = await engine.submit('a1',
    buy({ orderType: 'LIMIT', limitPriceVnd: 120_000 }), ctx());  // >7% của 100.000
  assert.equal(r.status, 'REJECTED');
  assert.match(r.reason, /biên độ/);

  const { rows } = await client.query(`SELECT status, reject_reason FROM orders WHERE agent_id='a1'`);
  assert.equal(rows[0].status, 'REJECTED');
  assert.match(rows[0].reject_reason, /biên độ/);
});

test('LIMIT chưa chạm giá thì treo, chưa khớp', async () => {
  const r = await engine.submit('a1',
    buy({ orderType: 'LIMIT', limitPriceVnd: 95_000 }),
    ctx({ tickPriceMap: new Map([['HOSE:FPT', 100_000]]) }));
  assert.equal(r.status, 'PENDING');
  assert.equal((await repos.trading.getOpenPositions('a1')).length, 0);
});

test('matchPending khớp lệnh LIMIT khi giá chạm ở tick sau', async () => {
  await engine.submit('a1', buy({ orderType: 'LIMIT', limitPriceVnd: 95_000 }), ctx());
  const filled = await engine.matchPending('a1',
    ctx({ tickPriceMap: new Map([['HOSE:FPT', 94_500]]) }));

  assert.equal(filled.length, 1);
  const p = await loadPortfolio({ repos, agentId: 'a1', priceMap: new Map([['HOSE:FPT', 94_500]]) });
  assert.equal(p.positions[0].qtyTotal, 1000);
});

test('mua vượt tiền mặt bị từ chối, không tạo vị thế', async () => {
  const r = await engine.submit('a1', buy({ quantity: 20_000 }), ctx());
  assert.equal(r.status, 'REJECTED');
  assert.match(r.reason, /tiền mặt|tỷ trọng/);
  assert.equal((await repos.trading.getOpenPositions('a1')).length, 0);
});

test('bán cổ phiếu mua cùng ngày bị từ chối theo T+2', async () => {
  await engine.submit('a1', buy(), ctx());
  const r = await engine.submit('a1',
    { action: 'SELL', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET', limitPriceVnd: null, reason: 'x', confidence: 0.5 },
    ctx());

  assert.equal(r.status, 'REJECTED');
  assert.match(r.reason, /T\+2|bán được/);
});

test('bán được sau khi lô đã về tài khoản, tiền tăng lên', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });

  const before = await repos.agents.getCash('a1');
  const r = await engine.submit('a1',
    { action: 'SELL', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET', limitPriceVnd: null, reason: 'chốt lời', confidence: 0.8 },
    ctx({ tradeDate: '2026-07-23' }));

  assert.equal(r.status, 'FILLED');
  assert.ok(await repos.agents.getCash('a1') > before);
});

test('MARKET bán chịu trượt giá bất lợi (xuống)', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await refreshSellable({ repos, agentId: 'a1', today: '2026-07-23' });

  const r = await engine.submit('a1',
    { action: 'SELL', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET', limitPriceVnd: null, reason: 'x', confidence: 0.5 },
    ctx({ tradeDate: '2026-07-23' }));
  assert.ok(r.fillPriceVnd < 100_000, `bán phải trượt xuống, nhận ${r.fillPriceVnd}`);
});

test('HOLD không tạo lệnh nào', async () => {
  const r = await engine.submit('a1', { action: 'HOLD', symbol: 'HOSE:FPT', reason: 'chờ thêm' }, ctx());
  assert.equal(r.status, 'REJECTED');
  const { rows } = await client.query(`SELECT count(*)::int n FROM orders WHERE agent_id='a1'`);
  assert.equal(rows[0].n, 0, 'HOLD không được ghi lệnh');
});

test('chặn giao dịch khi lỗ ngày vượt ngưỡng', async () => {
  const r = await engine.submit('a1', buy(), ctx({ dayPnl: -60_000_000 }));
  assert.equal(r.status, 'REJECTED');
  assert.match(r.reason, /lỗ trong ngày/);
});

test('mọi lệnh khớp đều ghi trades kèm reasoning', async () => {
  await engine.submit('a1', buy({ reason: 'vượt kháng cự 100' }), ctx());
  const trades = await repos.trading.listTrades('a1', 10);
  assert.equal(trades.length, 1);
  assert.match(trades[0].reason, /kháng cự/);
});

test('thiếu giá tham chiếu thì từ chối, không đoán bừa', async () => {
  const r = await engine.submit('a1', buy({ symbol: 'HOSE:FPT' }),
    ctx({ refPriceMap: new Map(), tickPriceMap: new Map() }));
  assert.equal(r.status, 'REJECTED');
  assert.match(r.reason, /giá/);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/agent-runtime/tests/engine.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/sim/engine.js'`.

- [ ] **Step 3: Cài đặt `packages/agent-runtime/src/sim/engine.js`**

```js
import {
  parseSymbol, priceBand, roundToTick, normalizeQty,
  assertPlausibleVndPrice, LOT_SIZE,
} from './vn_rules.js';
import { buyCost, sellProceeds } from './fees.js';
import { checkBuy, checkSell, checkDailyLoss, DEFAULT_RISK } from './guardrails.js';
import { loadPortfolio, applyBuy, applySell } from './portfolio.js';

export const SLIPPAGE_PCT = 0.1;

/**
 * Trọng tài của hệ thống (spec §3.3). Agent chỉ ĐỀ XUẤT; engine kiểm tra
 * luật thị trường, hàng rào rủi ro, rồi mới cho khớp. Mọi lệnh bị từ chối
 * đều được ghi vào orders kèm lý do — đó là dữ liệu học, không phải sự cố.
 */
export function createEngine({ repos, logger = console, slippagePct = SLIPPAGE_PCT }) {

  /** MARKET luôn trượt theo hướng BẤT LỢI cho người đặt lệnh. */
  function slip(priceVnd, side) {
    const factor = side === 'BUY' ? 1 + slippagePct / 100 : 1 - slippagePct / 100;
    return roundToTick(Math.round(priceVnd * factor));
  }

  async function reject(agentId, orderId, reason) {
    if (orderId) await repos.trading.rejectOrder(agentId, orderId, reason);
    return { status: 'REJECTED', orderId, reason };
  }

  async function settleFill(agentId, order, decision, priceVnd, ctx) {
    const { symbol, qty, side } = order;

    if (side === 'BUY') {
      const c = buyCost({ priceVnd, qty });
      await repos.trading.fillOrder(agentId, order.id, { qty, priceVnd, fee: c.fee, tax: 0 });
      await applyBuy({
        repos, agentId, symbol, qty, priceVnd, cost: c.total,
        tradeDate: ctx.tradeDate, exitPlan: decision.exitPlan,
      });
    } else {
      const s = sellProceeds({ priceVnd, qty });
      await repos.trading.fillOrder(agentId, order.id, { qty, priceVnd, fee: s.fee, tax: s.tax });
      await applySell({ repos, agentId, symbol, qty, priceVnd, proceeds: s.net });
    }

    await repos.trading.insertTrade(agentId, {
      symbol, action: side, priceVnd, qty,
      reason: decision.reason, confidence: decision.confidence,
      trigger: decision.trigger ?? null,
    });

    logger.info(`[engine] ${agentId} ${side} ${qty} ${symbol} @ ${priceVnd}`);
    return { status: 'FILLED', orderId: order.id, fillPriceVnd: priceVnd };
  }

  async function submit(agentId, decision, ctx) {
    const risk = ctx.risk ?? DEFAULT_RISK;

    // HOLD không phải lệnh — không ghi gì vào orders.
    if (decision.action === 'HOLD') {
      return { status: 'REJECTED', orderId: null, reason: 'HOLD — không đặt lệnh' };
    }
    if (decision.action !== 'BUY' && decision.action !== 'SELL') {
      return { status: 'REJECTED', orderId: null, reason: `hành động không hợp lệ: ${decision.action}` };
    }

    const side = decision.action;
    const symbol = decision.symbol;

    let exchange;
    try {
      ({ exchange } = parseSymbol(symbol));
    } catch (err) {
      return { status: 'REJECTED', orderId: null, reason: err.message };
    }

    const refPrice = ctx.refPriceMap.get(symbol);
    const tickPrice = ctx.tickPriceMap.get(symbol) ?? refPrice;
    if (!Number.isFinite(refPrice) || !Number.isFinite(tickPrice)) {
      return { status: 'REJECTED', orderId: null, reason: `không có giá cho ${symbol}` };
    }
    try {
      assertPlausibleVndPrice(refPrice, symbol);
    } catch (err) {
      return { status: 'REJECTED', orderId: null, reason: err.message };
    }

    const qty = normalizeQty(Math.trunc(decision.quantity ?? 0));
    if (qty < LOT_SIZE) {
      return { status: 'REJECTED', orderId: null,
        reason: `khối lượng ${decision.quantity} nhỏ hơn một lô chẵn (${LOT_SIZE})` };
    }

    // Ghi lệnh TRƯỚC khi kiểm tra, để lệnh bị từ chối cũng có dấu vết học được.
    const { id: orderId } = await repos.trading.insertOrder(agentId, {
      symbol, side, qty, orderType: decision.orderType ?? 'MARKET',
      limitPriceVnd: decision.limitPriceVnd ?? null,
    });

    const loss = checkDailyLoss({ dayPnl: ctx.dayPnl, nav: ctx.nav, risk });
    if (!loss.ok) return reject(agentId, orderId, loss.reason);

    const band = priceBand(refPrice, exchange);
    const limit = decision.limitPriceVnd;
    if (decision.orderType === 'LIMIT') {
      if (!Number.isFinite(limit)) return reject(agentId, orderId, 'lệnh LIMIT thiếu giá');
      if (limit < band.floor || limit > band.ceiling) {
        return reject(agentId, orderId,
          `giá ${limit} ngoài biên độ ${exchange} [${band.floor}, ${band.ceiling}]`);
      }
    }

    const portfolio = await loadPortfolio({ repos, agentId, priceMap: ctx.tickPriceMap });

    if (side === 'BUY') {
      const execPrice = decision.orderType === 'LIMIT' ? limit : slip(tickPrice, 'BUY');
      const cost = buyCost({ priceVnd: execPrice, qty }).total;
      const g = checkBuy({
        symbol, costVnd: cost, cash: portfolio.cash, nav: portfolio.nav,
        positions: portfolio.positions, risk,
      });
      if (!g.ok) return reject(agentId, orderId, g.reason);

      // LIMIT chỉ khớp khi giá thị trường đã chạm tới.
      if (decision.orderType === 'LIMIT' && tickPrice > limit) {
        return { status: 'PENDING', orderId };
      }
      const fillPrice = decision.orderType === 'LIMIT' ? Math.min(limit, tickPrice) : execPrice;
      return settleFill(agentId, { id: orderId, symbol, qty, side }, decision, fillPrice, ctx);
    }

    const g = checkSell({ symbol, qty, positions: portfolio.positions });
    if (!g.ok) return reject(agentId, orderId, g.reason);

    if (decision.orderType === 'LIMIT' && tickPrice < limit) {
      return { status: 'PENDING', orderId };
    }
    const fillPrice = decision.orderType === 'LIMIT'
      ? Math.max(limit, tickPrice)
      : slip(tickPrice, 'SELL');
    return settleFill(agentId, { id: orderId, symbol, qty, side }, decision, fillPrice, ctx);
  }

  /** Đối chiếu các lệnh đang treo với tick mới. Trả về danh sách lệnh vừa khớp. */
  async function matchPending(agentId, ctx) {
    const open = await repos.trading.listOpenOrders(agentId);
    const filled = [];

    for (const o of open) {
      const tickPrice = ctx.tickPriceMap.get(o.symbol);
      if (!Number.isFinite(tickPrice)) continue;

      const touched = o.side === 'BUY'
        ? tickPrice <= o.limitPriceVnd
        : tickPrice >= o.limitPriceVnd;
      if (!touched) continue;

      const fillPrice = o.side === 'BUY'
        ? Math.min(o.limitPriceVnd, tickPrice)
        : Math.max(o.limitPriceVnd, tickPrice);

      const decision = { reason: 'khớp lệnh treo', confidence: null, exitPlan: {} };
      const r = await settleFill(agentId, o, decision, fillPrice, ctx);
      filled.push(r);
    }
    return filled;
  }

  return { submit, matchPending };
}
```

- [ ] **Step 4: Chạy test**

```bash
node --test packages/agent-runtime/tests/engine.test.js
node --test packages/agent-runtime/tests/engine.test.js
npm test
```

Kỳ vọng: 15/15 hai lần; toàn suite xanh.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(sim): order lifecycle and tick-based matching engine"
```

---

### Task 7: PnL và snapshot cuối phiên

**Files:**
- Create: `packages/agent-runtime/src/sim/pnl.js`
- Test: `packages/agent-runtime/tests/pnl.test.js`

**Interfaces:**
- Consumes: `loadPortfolio` (Task 5), `createAgentsRepo` (Task 3)
- Produces:
  - `closeSession({ repos, agentId, tradeDate, priceMap }) → { cash, marketValue, nav, dayPnl, totalReturnPct }`
  - `dayPnl` = NAV hôm nay − NAV snapshot gần nhất trước đó
  - `totalReturnPct` = (NAV − initialCapital) / initialCapital × 100

- [ ] **Step 1: Viết test thất bại**

`packages/agent-runtime/tests/pnl.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo, createTradingRepo } from '@stockagents/db';
import { applyBuy } from '../src/sim/portfolio.js';
import { closeSession } from '../src/sim/pnl.js';

let client, repos;

before(async () => {
  client = await withTestDb();
  repos = { agents: createAgentsRepo(client), trading: createTradingRepo(client) };
});
beforeEach(async () => {
  await resetTables(client, [
    'position_lots', 'fills', 'orders', 'trade_outcomes', 'trades',
    'positions', 'portfolio_snapshot', 'metrics_daily', 'agents', 'universe',
  ]);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE')`);
  await repos.agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
});
after(async () => { await client.close(); });

test('phiên không giao dịch: NAV giữ nguyên, PnL bằng 0', async () => {
  const r = await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-20', priceMap: new Map() });
  assert.equal(r.nav, 1_000_000_000);
  assert.equal(r.dayPnl, 0);
  assert.equal(r.totalReturnPct, 0);
});

test('giá tăng làm NAV tăng, PnL ngày dương', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  const r = await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-20', priceMap: new Map([['HOSE:FPT', 110_000]]) });

  // tiền 899.850.000 + giá trị 110.000.000 = 1.009.850.000
  assert.equal(r.nav, 1_009_850_000);
  assert.equal(r.dayPnl, 9_850_000);
  assert.ok(r.totalReturnPct > 0.9 && r.totalReturnPct < 1.0);
});

test('phí giao dịch làm NAV giảm khi giá đứng yên', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  const r = await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-20', priceMap: new Map([['HOSE:FPT', 100_000]]) });

  assert.equal(r.dayPnl, -150_000, 'đúng bằng phí mua');
});

test('PnL ngày tính so với snapshot phiên TRƯỚC, không phải vốn ban đầu', async () => {
  await applyBuy({ repos, agentId: 'a1', symbol: 'HOSE:FPT', qty: 1000, priceVnd: 100_000, cost: 100_150_000, tradeDate: '2026-07-20' });
  await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-20', priceMap: new Map([['HOSE:FPT', 110_000]]) });

  const r2 = await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-21', priceMap: new Map([['HOSE:FPT', 115_000]]) });
  assert.equal(r2.dayPnl, 5_000_000, 'chỉ phần tăng so với hôm trước');
});

test('closeSession lưu snapshot đọc lại được', async () => {
  await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-20', priceMap: new Map() });
  const s = await repos.agents.getSnapshot('a1', '2026-07-20');
  assert.equal(s.nav, 1_000_000_000);
});

test('chạy lại cùng ngày ghi đè, không nhân đôi', async () => {
  await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-20', priceMap: new Map() });
  await closeSession({ repos, agentId: 'a1', tradeDate: '2026-07-20', priceMap: new Map() });

  const { rows } = await client.query(
    `SELECT count(*)::int n FROM portfolio_snapshot WHERE agent_id='a1' AND snap_date='2026-07-20'`);
  assert.equal(rows[0].n, 1);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/agent-runtime/tests/pnl.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/sim/pnl.js'`.

- [ ] **Step 3: Cài đặt `packages/agent-runtime/src/sim/pnl.js`**

```js
import { loadPortfolio } from './portfolio.js';

/**
 * Chốt phiên: mark-to-market toàn bộ vị thế và ghi snapshot.
 *
 * dayPnl so với snapshot GẦN NHẤT TRƯỚC ĐÓ, không phải vốn ban đầu — nếu
 * không, "lãi/lỗ trong ngày" sẽ thành "lãi/lỗ luỹ kế" và ngưỡng chặn lỗ ngày
 * (guardrails) sẽ hiểu sai hoàn toàn.
 */
export async function closeSession({ repos, agentId, tradeDate, priceMap }) {
  const agent = await repos.agents.get(agentId);
  if (!agent) throw new Error(`closeSession: không tìm thấy agent ${agentId}`);

  const p = await loadPortfolio({ repos, agentId, priceMap });

  const prev = await previousNav(repos, agentId, tradeDate);
  const dayPnl = p.nav - prev;

  await repos.agents.saveSnapshot(agentId, tradeDate, {
    cash: p.cash, marketValue: p.marketValue, nav: p.nav, dayPnl,
  });

  const totalReturnPct =
    Math.round(((p.nav - agent.initialCapital) / agent.initialCapital) * 10000) / 100;

  return { cash: p.cash, marketValue: p.marketValue, nav: p.nav, dayPnl, totalReturnPct };
}

/**
 * Mốc so sánh là snapshot của phiên TRƯỚC ĐÓ, không phải snapshot cùng ngày —
 * nếu lấy cùng ngày thì chạy lại lần hai sẽ luôn cho dayPnl = 0.
 */
async function previousNav(repos, agentId, tradeDate) {
  const snap = await repos.agents.getPreviousSnapshot(agentId, tradeDate);
  return snap ? snap.nav : (await repos.agents.get(agentId)).initialCapital;
}
```

`getPreviousSnapshot` chưa có ở Task 3 — thêm vào `packages/db/src/repositories/agents.js` trong task này (nó là phần phụ thuộc của chính deliverable này) và nhớ đưa vào object `return`:

```js
  async function getPreviousSnapshot(agentId, beforeDate) {
    const id = assertAgentScope(agentId, 'getPreviousSnapshot');
    const { rows } = await client.query(
      `SELECT cash, market_value AS "marketValue", nav, day_pnl AS "dayPnl"
       FROM portfolio_snapshot
       WHERE agent_id = $1 AND snap_date < $2
       ORDER BY snap_date DESC LIMIT 1`, [id, beforeDate]);
    if (!rows[0]) return null;
    return {
      cash: num(rows[0].cash), marketValue: num(rows[0].marketValue),
      nav: num(rows[0].nav), dayPnl: num(rows[0].dayPnl),
    };
  }
```

> Lưu ý: `upsertMany` ở Task 3 ghi một snapshot mốc ở ngày `1970-01-01` mang vốn ban đầu, nên `getPreviousSnapshot` luôn tìm được mốc so sánh cho phiên đầu tiên.

- [ ] **Step 4: Chạy test**

```bash
node --test packages/agent-runtime/tests/pnl.test.js
node --test packages/agent-runtime/tests/pnl.test.js
npm test
```

Kỳ vọng: 6/6 hai lần; toàn suite xanh.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-runtime packages/db
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(sim): session close with mark-to-market PnL"
```

---

### Task 8: Lớp LLM — schema quyết định, provider và stub

**Files:**
- Create: `packages/agent-runtime/src/llm/decision_schema.js`
- Create: `packages/agent-runtime/src/llm/stub.js`
- Create: `packages/agent-runtime/src/llm/anthropic.js`
- Create: `packages/agent-runtime/src/llm/provider.js`
- Test: `packages/agent-runtime/tests/llm.test.js`

**Interfaces:**
- Consumes: không
- Produces:
  - `DECISION_KEYS`, `validateDecision(raw) → { ok, value?, errors? }`
  - `createStubProvider({ script })` → `{ name: 'stub', complete({system, messages, jsonSchema}) → object }`
  - `createAnthropicProvider({ apiKey, model })` → cùng interface
  - `createProvider({ provider, model, apiKey })` → provider tương ứng; `'stub'` không cần key

- [ ] **Step 1: Viết test thất bại**

`packages/agent-runtime/tests/llm.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision } from '../src/llm/decision_schema.js';
import { createStubProvider } from '../src/llm/stub.js';
import { createProvider } from '../src/llm/provider.js';

const good = {
  action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'LIMIT',
  limitPriceVnd: 118500, confidence: 0.72, reason: 'vượt MA20',
  exitPlan: { takeProfitPct: 8, stopLossPct: -4, timeStopDays: 10 },
};

test('validateDecision chấp nhận quyết định hợp lệ', () => {
  const r = validateDecision(good);
  assert.equal(r.ok, true);
  assert.equal(r.value.action, 'BUY');
});

test('validateDecision từ chối hành động lạ', () => {
  const r = validateDecision({ ...good, action: 'YOLO' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /action/);
});

test('validateDecision từ chối confidence ngoài 0..1', () => {
  assert.equal(validateDecision({ ...good, confidence: 5 }).ok, false);
  assert.equal(validateDecision({ ...good, confidence: -0.1 }).ok, false);
});

test('validateDecision bắt buộc có reason không rỗng', () => {
  const r = validateDecision({ ...good, reason: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /reason/);
});

test('validateDecision từ chối quantity không phải số nguyên dương', () => {
  assert.equal(validateDecision({ ...good, quantity: 0 }).ok, false);
  assert.equal(validateDecision({ ...good, quantity: 10.5 }).ok, false);
});

test('HOLD không cần quantity hay giá', () => {
  const r = validateDecision({ action: 'HOLD', symbol: 'HOSE:FPT', reason: 'chờ', confidence: 0.5 });
  assert.equal(r.ok, true);
});

test('LIMIT bắt buộc có limitPriceVnd', () => {
  const r = validateDecision({ ...good, orderType: 'LIMIT', limitPriceVnd: null });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /limitPriceVnd/);
});

test('validateDecision gom NHIỀU lỗi, không dừng ở lỗi đầu', () => {
  const r = validateDecision({ action: 'YOLO', symbol: '', quantity: -5, reason: '' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 3, `kỳ vọng nhiều lỗi, nhận ${r.errors.length}`);
});

test('stub provider trả kết quả tất định theo kịch bản', async () => {
  const p = createStubProvider({ script: [[good]] });
  const first = await p.complete({ system: 's', messages: [], jsonSchema: {} });
  assert.deepEqual(first, [good]);
});

test('stub provider lặp lại phần tử cuối khi hết kịch bản', async () => {
  const p = createStubProvider({ script: [[good]] });
  await p.complete({ system: 's', messages: [], jsonSchema: {} });
  const second = await p.complete({ system: 's', messages: [], jsonSchema: {} });
  assert.deepEqual(second, [good]);
});

test('stub provider mặc định trả HOLD khi không có kịch bản', async () => {
  const p = createStubProvider({});
  const r = await p.complete({ system: 's', messages: [], jsonSchema: {} });
  assert.equal(Array.isArray(r), true);
  assert.equal(r[0].action, 'HOLD');
});

test('createProvider chọn stub mà không cần API key', () => {
  const p = createProvider({ provider: 'stub' });
  assert.equal(p.name, 'stub');
});

test('createProvider báo lỗi rõ khi thiếu API key của provider thật', () => {
  assert.throws(
    () => createProvider({ provider: 'anthropic', model: 'claude-opus-5', apiKey: '' }),
    /ANTHROPIC_API_KEY/,
  );
});

test('createProvider từ chối provider không biết', () => {
  assert.throws(() => createProvider({ provider: 'magic' }), /magic/);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/agent-runtime/tests/llm.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/llm/decision_schema.js'`.

- [ ] **Step 3: Cài đặt `packages/agent-runtime/src/llm/decision_schema.js`**

```js
/**
 * Hợp đồng quyết định của agent (spec §6.2).
 * Đầu ra LLM PHẢI qua đây trước khi chạm engine — LLM không được giữ
 * quy tắc an toàn, và cũng không được tin là trả đúng định dạng.
 *
 * Gom TẤT CẢ lỗi thay vì dừng ở lỗi đầu: khi cần sửa prompt, thấy hết
 * vấn đề một lần thì nhanh hơn nhiều so với sửa từng cái một.
 */

export const DECISION_KEYS = [
  'action', 'symbol', 'quantity', 'orderType', 'limitPriceVnd',
  'confidence', 'reason', 'exitPlan',
];

const ACTIONS = new Set(['BUY', 'SELL', 'HOLD']);
const ORDER_TYPES = new Set(['MARKET', 'LIMIT', 'ATC']);

export function validateDecision(raw) {
  const errors = [];
  const d = raw ?? {};

  if (!ACTIONS.has(d.action)) {
    errors.push(`action phải thuộc ${[...ACTIONS].join('/')}, nhận: ${d.action}`);
  }
  if (typeof d.symbol !== 'string' || d.symbol.trim() === '') {
    errors.push('symbol phải là chuỗi không rỗng');
  }
  if (typeof d.reason !== 'string' || d.reason.trim() === '') {
    errors.push('reason bắt buộc và không được rỗng — lý do là dữ liệu cho vòng học');
  }
  if (d.confidence !== null && d.confidence !== undefined) {
    if (typeof d.confidence !== 'number' || !(d.confidence >= 0 && d.confidence <= 1)) {
      errors.push(`confidence phải trong khoảng 0..1, nhận: ${d.confidence}`);
    }
  }

  if (d.action === 'BUY' || d.action === 'SELL') {
    if (!Number.isInteger(d.quantity) || d.quantity <= 0) {
      errors.push(`quantity phải là số nguyên dương, nhận: ${d.quantity}`);
    }
    const type = d.orderType ?? 'MARKET';
    if (!ORDER_TYPES.has(type)) {
      errors.push(`orderType phải thuộc ${[...ORDER_TYPES].join('/')}, nhận: ${type}`);
    }
    if (type === 'LIMIT' && !Number.isFinite(d.limitPriceVnd)) {
      errors.push('orderType LIMIT bắt buộc có limitPriceVnd là số');
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      action: d.action,
      symbol: d.symbol.trim(),
      quantity: d.quantity ?? null,
      orderType: d.orderType ?? 'MARKET',
      limitPriceVnd: Number.isFinite(d.limitPriceVnd) ? d.limitPriceVnd : null,
      confidence: typeof d.confidence === 'number' ? d.confidence : null,
      reason: d.reason.trim(),
      exitPlan: d.exitPlan ?? {},
    },
  };
}
```

- [ ] **Step 4: Cài đặt `packages/agent-runtime/src/llm/stub.js`**

```js
/**
 * Provider tất định. Cho phép toàn bộ Phase 2 chạy và test được mà không
 * cần API key, không cần mạng, và không tốn token.
 *
 * `script` là mảng các phản hồi. Mỗi lần gọi lấy phần tử kế tiếp; hết
 * kịch bản thì lặp lại phần tử cuối (để vòng lặp phiên không bị đói).
 */
export function createStubProvider({ script = [] } = {}) {
  let i = 0;
  const fallback = [{
    action: 'HOLD', symbol: 'HOSE:FPT', quantity: null, orderType: 'MARKET',
    limitPriceVnd: null, confidence: 0.5,
    reason: 'stub provider: không có kịch bản, giữ nguyên',
    exitPlan: {},
  }];

  return {
    name: 'stub',
    async complete() {
      if (script.length === 0) return structuredClone(fallback);
      const out = script[Math.min(i, script.length - 1)];
      i++;
      return structuredClone(out);
    },
  };
}
```

- [ ] **Step 5: Cài đặt `packages/agent-runtime/src/llm/anthropic.js`**

```js
/**
 * Provider Claude. Dùng tool-use để ép structured output — đó là cách
 * đáng tin nhất để nhận JSON đúng schema từ Claude.
 *
 * Gọi HTTP trực tiếp, không thêm SDK: chỉ một endpoint, và thêm dependency
 * cho một lời gọi fetch là không đáng.
 */
const API_URL = 'https://api.anthropic.com/v1/messages';

export function createAnthropicProvider({ apiKey, model, fetchImpl = fetch }) {
  return {
    name: 'anthropic',
    async complete({ system, messages, jsonSchema, maxTokens = 2048, temperature = 1 }) {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          system,
          messages,
          tools: [{
            name: 'submit_decisions',
            description: 'Nộp danh sách quyết định giao dịch',
            input_schema: jsonSchema,
          }],
          tool_choice: { type: 'tool', name: 'submit_decisions' },
        }),
      });

      if (!res.ok) {
        throw new Error(`anthropic: HTTP ${res.status} — ${await res.text()}`);
      }
      const body = await res.json();
      const toolUse = body.content?.find(c => c.type === 'tool_use');
      if (!toolUse) {
        throw new Error('anthropic: phản hồi không chứa tool_use — không lấy được JSON');
      }
      return toolUse.input.decisions ?? toolUse.input;
    },
  };
}
```

- [ ] **Step 6: Cài đặt `packages/agent-runtime/src/llm/provider.js`**

```js
import { createStubProvider } from './stub.js';
import { createAnthropicProvider } from './anthropic.js';

const ENV_KEY = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

export function createProvider({ provider, model, apiKey, script }) {
  if (provider === 'stub') return createStubProvider({ script });

  const envName = ENV_KEY[provider];
  if (!envName) {
    throw new Error(
      `createProvider: không biết provider '${provider}'. ` +
      `Hỗ trợ: stub, ${Object.keys(ENV_KEY).join(', ')}.`);
  }

  const key = apiKey ?? process.env[envName];
  if (!key || String(key).trim() === '') {
    throw new Error(
      `createProvider: thiếu ${envName} cho provider '${provider}'. ` +
      `Điền vào .env, hoặc dùng provider 'stub' để chạy không cần API key.`);
  }

  if (provider === 'anthropic') return createAnthropicProvider({ apiKey: key, model });

  throw new Error(
    `createProvider: provider '${provider}' sẽ được thêm ở Phase 5. ` +
    `Hiện hỗ trợ: stub, anthropic.`);
}
```

- [ ] **Step 7: Chạy test**

```bash
node --test packages/agent-runtime/tests/llm.test.js
node --test packages/agent-runtime/tests/llm.test.js
npm test
```

Kỳ vọng: 14/14 hai lần; toàn suite xanh.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-runtime
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(llm): decision schema, provider interface, stub and anthropic"
```

---

### Task 9: Agent — registry, context, runner

**Files:**
- Create: `config/agents.json`
- Create: `packages/agent-runtime/src/agents/registry.js`
- Create: `packages/agent-runtime/src/agents/context.js`
- Create: `packages/agent-runtime/src/agents/runner.js`
- Test: `packages/agent-runtime/tests/agent.test.js`

**Interfaces:**
- Consumes: `validateDecision`, `createProvider` (Task 8); `loadPortfolio` (Task 5); `createEngine` (Task 6); repos (Task 3)
- Produces:
  - `loadAgentDefs(path?) → AgentDef[]` với `AgentDef = { id, name, provider, model, personaPrompt, initialCapital, riskConfig }`
  - `buildContext({ repos, agentId, tradeDate, universe, snapshots, priceMap, trigger }) → object`
  - `createRunner({ repos, engine, provider, logger })` → `{ runOnce({ agentId, agentDef, context, ctx }) → { decisions, results } }`
  - Quyết định sai schema bị bỏ và ghi log, **không** làm hỏng lượt chạy.

- [ ] **Step 1: Tạo `config/agents.json`**

```json
[
  {
    "id": "claude_value",
    "name": "Claude Value",
    "provider": "anthropic",
    "model": "claude-opus-5",
    "initialCapital": 1000000000,
    "riskConfig": { "maxPositions": 8, "maxPositionPctNav": 20, "dailyLossLimitPct": 5 },
    "personaPrompt": "Bạn là nhà đầu tư giá trị, kiên nhẫn, giao dịch cổ phiếu Việt Nam. Bạn ưu tiên doanh nghiệp có nền tảng tốt và định giá hợp lý hơn là biến động ngắn hạn. Bạn giữ vị thế dài, đặt cắt lỗ rộng, và sẵn sàng không mua gì nếu không thấy cơ hội đủ tốt. Mọi quyết định phải nêu lý do cụ thể dựa trên dữ liệu được cung cấp."
  }
]
```

- [ ] **Step 2: Viết test thất bại**

`packages/agent-runtime/tests/agent.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo, createTradingRepo } from '@stockagents/db';
import { loadAgentDefs } from '../src/agents/registry.js';
import { buildContext } from '../src/agents/context.js';
import { createRunner } from '../src/agents/runner.js';
import { createStubProvider } from '../src/llm/stub.js';
import { createEngine } from '../src/sim/engine.js';
import { DEFAULT_RISK } from '../src/sim/guardrails.js';

const silent = { info() {}, warn() {}, error() {} };
let client, repos, engine;

const ctx = () => ({
  tradeDate: '2026-07-20',
  refPriceMap: new Map([['HOSE:FPT', 100_000]]),
  tickPriceMap: new Map([['HOSE:FPT', 100_000]]),
  nav: 1_000_000_000, dayPnl: 0, risk: DEFAULT_RISK,
});

before(async () => {
  client = await withTestDb();
  repos = { agents: createAgentsRepo(client), trading: createTradingRepo(client) };
  engine = createEngine({ repos, logger: silent });
});
beforeEach(async () => {
  await resetTables(client, [
    'position_lots', 'fills', 'orders', 'trade_outcomes', 'trades',
    'positions', 'portfolio_snapshot', 'metrics_daily', 'agents', 'universe',
  ]);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT','HOSE')`);
  await repos.agents.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
});
after(async () => { await client.close(); });

test('loadAgentDefs đọc được định nghĩa agent từ config', async () => {
  const defs = await loadAgentDefs();
  assert.ok(defs.length >= 1);
  assert.equal(defs[0].id, 'claude_value');
  assert.ok(defs[0].personaPrompt.length > 50);
});

test('buildContext gói đủ danh mục, universe và ràng buộc', async () => {
  const c = await buildContext({
    repos, agentId: 'a1', tradeDate: '2026-07-20',
    universe: [{ symbol: 'HOSE:FPT', sector: 'Công nghệ' }],
    snapshots: new Map([['HOSE:FPT', { rsi14: 62.5, ma20: 98000 }]]),
    priceMap: new Map([['HOSE:FPT', 100_000]]),
    trigger: 'SESSION_OPEN',
  });

  assert.equal(c.trigger, 'SESSION_OPEN');
  assert.equal(c.portfolio.cash, 1_000_000_000);
  assert.equal(c.universe.length, 1);
  assert.equal(c.universe[0].indicators.rsi14, 62.5);
  assert.ok(c.constraints.availableCash > 0);
});

test('buildContext KHÔNG lộ dữ liệu của agent khác', async () => {
  await repos.agents.upsertMany([
    { id: 'a2', name: 'A2', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
  await repos.trading.insertTrade('a2', {
    symbol: 'HOSE:FPT', action: 'BUY', priceVnd: 100000, qty: 100,
    reason: 'bí mật của a2', confidence: 0.9,
  });

  const c = await buildContext({
    repos, agentId: 'a1', tradeDate: '2026-07-20',
    universe: [], snapshots: new Map(), priceMap: new Map(), trigger: 'SESSION_OPEN',
  });

  assert.equal(JSON.stringify(c).includes('bí mật của a2'), false);
  assert.deepEqual(c.memory.recentTrades, []);
});

test('runOnce nộp quyết định hợp lệ cho engine và khớp lệnh', async () => {
  const provider = createStubProvider({ script: [[{
    action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
    limitPriceVnd: null, confidence: 0.7, reason: 'stub mua thử', exitPlan: {},
  }]] });
  const runner = createRunner({ repos, engine, provider, logger: silent });

  const r = await runner.runOnce({
    agentId: 'a1',
    agentDef: { id: 'a1', personaPrompt: 'p', riskConfig: DEFAULT_RISK },
    context: {}, ctx: ctx(),
  });

  assert.equal(r.results[0].status, 'FILLED');
  assert.equal((await repos.trading.getOpenPositions('a1')).length, 1);
});

test('quyết định sai schema bị bỏ, lượt chạy vẫn hoàn tất', async () => {
  const provider = createStubProvider({ script: [[
    { action: 'YOLO', symbol: 'HOSE:FPT', reason: '' },
    { action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET', limitPriceVnd: null, confidence: 0.7, reason: 'hợp lệ', exitPlan: {} },
  ]] });
  const runner = createRunner({ repos, engine, provider, logger: silent });

  const r = await runner.runOnce({
    agentId: 'a1', agentDef: { id: 'a1', personaPrompt: 'p', riskConfig: DEFAULT_RISK },
    context: {}, ctx: ctx(),
  });

  assert.equal(r.decisions.length, 1, 'chỉ quyết định hợp lệ được giữ');
  assert.equal(r.invalid.length, 1);
  assert.equal(r.results[0].status, 'FILLED');
});

test('provider ném lỗi thì runOnce trả SKIPPED, không sập', async () => {
  const provider = { name: 'boom', async complete() { throw new Error('rate limit'); } };
  const runner = createRunner({ repos, engine, provider, logger: silent });

  const r = await runner.runOnce({
    agentId: 'a1', agentDef: { id: 'a1', personaPrompt: 'p', riskConfig: DEFAULT_RISK },
    context: {}, ctx: ctx(),
  });

  assert.equal(r.status, 'SKIPPED');
  assert.match(r.error, /rate limit/);
});

test('provider trả thứ không phải mảng vẫn xử lý được', async () => {
  const provider = { name: 'weird', async complete() { return { action: 'HOLD', symbol: 'HOSE:FPT', reason: 'một object đơn lẻ', confidence: 0.5 }; } };
  const runner = createRunner({ repos, engine, provider, logger: silent });

  const r = await runner.runOnce({
    agentId: 'a1', agentDef: { id: 'a1', personaPrompt: 'p', riskConfig: DEFAULT_RISK },
    context: {}, ctx: ctx(),
  });
  assert.equal(r.decisions.length, 1);
});
```

- [ ] **Step 3: Chạy test, xác nhận thất bại**

```bash
node --test packages/agent-runtime/tests/agent.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/agents/registry.js'`.

- [ ] **Step 4: Cài đặt `packages/agent-runtime/src/agents/registry.js`**

```js
import { readFile } from 'node:fs/promises';

const DEFAULT_PATH = new URL('../../../../config/agents.json', import.meta.url);

export async function loadAgentDefs(path = DEFAULT_PATH) {
  const raw = await readFile(path, 'utf8');
  const defs = JSON.parse(raw);
  if (!Array.isArray(defs) || defs.length === 0) {
    throw new Error('loadAgentDefs: config/agents.json phải là mảng không rỗng');
  }
  for (const d of defs) {
    for (const key of ['id', 'name', 'provider', 'model', 'personaPrompt', 'initialCapital']) {
      if (d[key] === undefined) {
        throw new Error(`loadAgentDefs: agent '${d.id ?? '?'}' thiếu trường '${key}'`);
      }
    }
  }
  return defs;
}
```

- [ ] **Step 5: Cài đặt `packages/agent-runtime/src/agents/context.js`**

```js
import { loadPortfolio } from '../sim/portfolio.js';
import { DEFAULT_RISK } from '../sim/guardrails.js';

/**
 * Dựng context đưa cho agent.
 *
 * MỌI truy vấn dữ liệu agent đều đi qua repository có assertAgentScope,
 * nên context của agent này không thể chứa dữ liệu của agent khác (spec §3.2).
 */
export async function buildContext({
  repos, agentId, tradeDate, universe, snapshots, priceMap,
  trigger = 'SESSION_OPEN', risk = DEFAULT_RISK, picksPerSession = 5,
}) {
  const portfolio = await loadPortfolio({ repos, agentId, priceMap });
  const recentTrades = await repos.trading.listTrades(agentId, 20);

  return {
    asOf: tradeDate,
    trigger,
    universe: universe.map(u => ({
      symbol: u.symbol,
      sector: u.sector ?? null,
      lastPriceVnd: priceMap.get(u.symbol) ?? null,
      indicators: snapshots.get(u.symbol) ?? {},
    })),
    portfolio: {
      cash: portfolio.cash,
      nav: portfolio.nav,
      positions: portfolio.positions.map(p => ({
        symbol: p.symbol, qtyTotal: p.qtyTotal, qtySellable: p.qtySellable,
        avgCostVnd: p.avgCostVnd, unrealizedPct: p.unrealizedPct, exitPlan: p.exitPlan,
      })),
    },
    memory: {
      recentTrades: recentTrades.map(t => ({
        symbol: t.symbol, action: t.action, priceVnd: t.priceVnd,
        qty: t.qty, reason: t.reason, decidedAt: t.decidedAt,
      })),
      lessons: [],   // Phase 6
    },
    constraints: {
      maxNewPicks: picksPerSession,
      maxPositions: risk.maxPositions,
      maxPositionPctNav: risk.maxPositionPctNav,
      minLot: 100,
      availableCash: portfolio.cash,
      tradableSymbols: universe.map(u => u.symbol),
    },
  };
}
```

- [ ] **Step 6: Cài đặt `packages/agent-runtime/src/agents/runner.js`**

```js
import { validateDecision } from '../llm/decision_schema.js';

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD'] },
          symbol: { type: 'string' },
          quantity: { type: 'integer' },
          orderType: { type: 'string', enum: ['MARKET', 'LIMIT', 'ATC'] },
          limitPriceVnd: { type: 'number' },
          confidence: { type: 'number' },
          reason: { type: 'string' },
          exitPlan: {
            type: 'object',
            properties: {
              takeProfitPct: { type: 'number' },
              stopLossPct: { type: 'number' },
              timeStopDays: { type: 'integer' },
              trailingPct: { type: 'number' },
            },
          },
        },
        required: ['action', 'symbol', 'reason'],
      },
    },
  },
  required: ['decisions'],
};

export function createRunner({ repos, engine, provider, logger = console }) {

  async function runOnce({ agentId, agentDef, context, ctx }) {
    let raw;
    try {
      raw = await provider.complete({
        system: agentDef.personaPrompt,
        messages: [{ role: 'user', content: JSON.stringify(context) }],
        jsonSchema: DECISION_SCHEMA,
      });
    } catch (err) {
      // Provider chết thì agent BỎ LƯỢT — không fallback sang model khác,
      // vì như vậy sẽ làm hỏng việc so sánh giữa các agent (spec §6.5).
      logger.warn(`[runner] ${agentId} bỏ lượt: ${err.message}`);
      return { status: 'SKIPPED', error: err.message, decisions: [], invalid: [], results: [] };
    }

    const list = Array.isArray(raw) ? raw : [raw];
    const decisions = [];
    const invalid = [];

    for (const item of list) {
      const v = validateDecision(item);
      if (v.ok) decisions.push(v.value);
      else {
        invalid.push({ raw: item, errors: v.errors });
        logger.warn(`[runner] ${agentId} quyết định sai schema: ${v.errors.join('; ')}`);
      }
    }

    const results = [];
    for (const d of decisions) {
      results.push(await engine.submit(agentId, d, {
        ...ctx, risk: agentDef.riskConfig ?? ctx.risk,
      }));
    }

    return { status: 'OK', decisions, invalid, results };
  }

  return { runOnce };
}
```

- [ ] **Step 7: Chạy test**

```bash
node --test packages/agent-runtime/tests/agent.test.js
node --test packages/agent-runtime/tests/agent.test.js
npm test
```

Kỳ vọng: 7/7 hai lần; toàn suite xanh.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-runtime config/agents.json
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(agents): registry, context builder and decision runner"
```

---

### Task 10: Session runner + CLI + tài liệu

**Files:**
- Create: `packages/agent-runtime/src/session.js`
- Create: `packages/agent-runtime/src/cli.js`
- Modify: root `package.json` (script `sim:session`)
- Modify: `README.md`
- Test: `packages/agent-runtime/tests/session.test.js`

**Interfaces:**
- Consumes: mọi task trước
- Produces:
  - `runSession({ client, agentId, tradeDate, provider, logger }) → { agentId, tradeDate, decisions, results, close }`
  - `close` là kết quả `closeSession` (Task 7)
  - CLI: `npm run sim:session -- --agent claude_value --date 2026-07-20`

- [ ] **Step 1: Viết test thất bại**

`packages/agent-runtime/tests/session.test.js`:

```js
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createAgentsRepo } from '@stockagents/db';
import { runSession } from '../src/session.js';
import { createStubProvider } from '../src/llm/stub.js';

const silent = { info() {}, warn() {}, error() {} };
let client, agentsRepo;

before(async () => {
  client = await withTestDb();
  agentsRepo = createAgentsRepo(client);
});
beforeEach(async () => {
  await resetTables(client, [
    'position_lots', 'fills', 'orders', 'trade_outcomes', 'trades',
    'positions', 'portfolio_snapshot', 'metrics_daily',
    'indicator_snapshot', 'quote_tick', 'ohlcv_daily', 'agents', 'universe',
  ]);
  await client.query(`INSERT INTO universe (symbol, exchange, sector) VALUES ('HOSE:FPT','HOSE','Công nghệ')`);
  await client.query(`INSERT INTO ohlcv_daily (symbol, trade_date, open, high, low, close, volume)
                      VALUES ('HOSE:FPT','2026-07-17', 99, 101, 98, 100, 1000000)`);
  await client.query(`INSERT INTO quote_tick (symbol, price, volume) VALUES ('HOSE:FPT', 100, 5000)`);
  await client.query(`INSERT INTO indicator_snapshot (symbol, payload) VALUES ('HOSE:FPT', '{"rsi14":62.5}')`);
  await agentsRepo.upsertMany([
    { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', personaPrompt: 'p', initialCapital: 1_000_000_000 },
  ]);
});
after(async () => { await client.close(); });

test('phiên chạy trọn vẹn với stub HOLD: không lệnh, có snapshot', async () => {
  const r = await runSession({
    client, agentId: 'a1', tradeDate: '2026-07-20',
    provider: createStubProvider({}), logger: silent,
  });

  assert.equal(r.results.length, 0);
  assert.equal(r.close.nav, 1_000_000_000);
  assert.ok(await agentsRepo.getSnapshot('a1', '2026-07-20'));
});

test('phiên với quyết định MUA: vị thế hình thành, NAV phản ánh phí', async () => {
  const provider = createStubProvider({ script: [[{
    action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
    limitPriceVnd: null, confidence: 0.7, reason: 'stub mua', exitPlan: { takeProfitPct: 8, stopLossPct: -4 },
  }]] });

  const r = await runSession({ client, agentId: 'a1', tradeDate: '2026-07-20', provider, logger: silent });

  assert.equal(r.results[0].status, 'FILLED');
  assert.ok(r.close.nav < 1_000_000_000, 'phí làm NAV giảm khi giá đứng yên');
  assert.ok(r.close.marketValue > 0);
});

test('giá được chuyển sang VND đúng đơn vị', async () => {
  const provider = createStubProvider({ script: [[{
    action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
    limitPriceVnd: null, confidence: 0.7, reason: 'kiểm tra đơn vị', exitPlan: {},
  }]] });

  const r = await runSession({ client, agentId: 'a1', tradeDate: '2026-07-20', provider, logger: silent });

  // quote 100 (nghìn đồng) -> 100.000 VND; 1000 cp -> ~100 triệu, không phải 100 nghìn
  assert.ok(r.close.marketValue > 90_000_000 && r.close.marketValue < 110_000_000,
    `giá trị thị trường ${r.close.marketValue} sai đơn vị`);
});

test('chạy lại cùng ngày không nhân đôi snapshot', async () => {
  await runSession({ client, agentId: 'a1', tradeDate: '2026-07-20', provider: createStubProvider({}), logger: silent });
  await runSession({ client, agentId: 'a1', tradeDate: '2026-07-20', provider: createStubProvider({}), logger: silent });

  const { rows } = await client.query(
    `SELECT count(*)::int n FROM portfolio_snapshot WHERE agent_id='a1' AND snap_date='2026-07-20'`);
  assert.equal(rows[0].n, 1);
});

test('không có dữ liệu giá thì phiên dừng sớm, không đoán bừa', async () => {
  await client.query('TRUNCATE quote_tick, ohlcv_daily CASCADE');
  const r = await runSession({
    client, agentId: 'a1', tradeDate: '2026-07-20',
    provider: createStubProvider({}), logger: silent,
  });
  assert.equal(r.status, 'NO_DATA');
  assert.equal(r.results.length, 0);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

```bash
node --test packages/agent-runtime/tests/session.test.js
```

Kỳ vọng: FAIL — `Cannot find module '../src/session.js'`.

- [ ] **Step 3: Cài đặt `packages/agent-runtime/src/session.js`**

```js
import {
  createAgentsRepo, createTradingRepo, createUniverseRepo, createMarketRepo,
} from '@stockagents/db';
import { toVnd } from './sim/vn_rules.js';
import { createEngine } from './sim/engine.js';
import { createRunner } from './agents/runner.js';
import { buildContext } from './agents/context.js';
import { refreshSellable } from './sim/portfolio.js';
import { closeSession } from './sim/pnl.js';
import { DEFAULT_RISK } from './sim/guardrails.js';

/**
 * Chạy trọn một phiên giả lập cho MỘT agent.
 *
 * Giá đọc từ DB ở đơn vị TradingView (nghìn đồng) và chuyển sang VND đúng
 * MỘT lần tại đây, qua toVnd(). Mọi thứ sau điểm này đều là VND.
 */
export async function runSession({ client, agentId, tradeDate, provider, agentDef, logger = console }) {
  const repos = {
    agents: createAgentsRepo(client),
    trading: createTradingRepo(client),
    universe: createUniverseRepo(client),
    market: createMarketRepo(client),
  };

  const universe = await repos.universe.listActive();
  const { refPriceMap, tickPriceMap } = await buildPriceMaps(client, universe);

  if (tickPriceMap.size === 0) {
    logger.warn(`[session] ${agentId}: không có dữ liệu giá cho ngày ${tradeDate}`);
    return { status: 'NO_DATA', agentId, tradeDate, decisions: [], results: [], close: null };
  }

  // T+2: mở khoá các lô đã về tài khoản trước khi agent nhìn danh mục.
  await refreshSellable({ repos, agentId, today: tradeDate });

  const snapshots = await buildIndicatorMap(client, universe);
  const def = agentDef ?? (await repos.agents.get(agentId));
  const risk = def?.riskConfig ?? DEFAULT_RISK;

  const context = await buildContext({
    repos, agentId, tradeDate,
    universe: universe.map(u => ({ symbol: u.symbol, sector: u.sector })),
    snapshots, priceMap: tickPriceMap, trigger: 'SESSION_OPEN', risk,
  });

  const prevSnap = await repos.agents.getPreviousSnapshot(agentId, tradeDate);
  const engine = createEngine({ repos, logger });
  const runner = createRunner({ repos, engine, provider, logger });

  const run = await runner.runOnce({
    agentId,
    agentDef: { ...def, personaPrompt: def?.personaPrompt ?? '', riskConfig: risk },
    context,
    ctx: {
      tradeDate, refPriceMap, tickPriceMap,
      nav: context.portfolio.nav,
      dayPnl: prevSnap ? context.portfolio.nav - prevSnap.nav : 0,
      risk,
    },
  });

  const close = await closeSession({ repos, agentId, tradeDate, priceMap: tickPriceMap });

  logger.info(
    `[session] ${agentId} ${tradeDate}: ${run.results.length} lệnh, ` +
    `NAV ${close.nav.toLocaleString('vi-VN')} (${close.totalReturnPct}%)`);

  return {
    status: run.status, agentId, tradeDate,
    decisions: run.decisions, invalid: run.invalid, results: run.results, close,
  };
}

async function buildPriceMaps(client, universe) {
  const symbols = universe.map(u => u.symbol);
  const refPriceMap = new Map();
  const tickPriceMap = new Map();
  if (symbols.length === 0) return { refPriceMap, tickPriceMap };

  // Giá tham chiếu = giá đóng cửa phiên gần nhất.
  const ref = await client.query(
    `SELECT DISTINCT ON (symbol) symbol, close FROM ohlcv_daily
     WHERE symbol = ANY($1) ORDER BY symbol, trade_date DESC`, [symbols]);
  for (const r of ref.rows) refPriceMap.set(r.symbol, toVnd(Number(r.close)));

  // Giá khớp = tick gần nhất; chưa có tick thì dùng giá tham chiếu.
  const tick = await client.query(
    `SELECT DISTINCT ON (symbol) symbol, price FROM quote_tick
     WHERE symbol = ANY($1) ORDER BY symbol, ts DESC`, [symbols]);
  for (const r of tick.rows) tickPriceMap.set(r.symbol, toVnd(Number(r.price)));
  for (const [s, p] of refPriceMap) if (!tickPriceMap.has(s)) tickPriceMap.set(s, p);

  return { refPriceMap, tickPriceMap };
}

async function buildIndicatorMap(client, universe) {
  const symbols = universe.map(u => u.symbol);
  const map = new Map();
  if (symbols.length === 0) return map;
  const { rows } = await client.query(
    `SELECT DISTINCT ON (symbol) symbol, payload FROM indicator_snapshot
     WHERE symbol = ANY($1) ORDER BY symbol, captured_at DESC`, [symbols]);
  for (const r of rows) {
    const { _raw, ...parsed } = r.payload ?? {};
    map.set(r.symbol, parsed);
  }
  return map;
}
```

- [ ] **Step 4: Cài đặt `packages/agent-runtime/src/cli.js`**

```js
import { parseArgs } from 'node:util';
import { createClient, loadConfig, createAgentsRepo } from '@stockagents/db';
import { loadAgentDefs } from './agents/registry.js';
import { createProvider } from './llm/provider.js';
import { runSession } from './session.js';

const { values } = parseArgs({
  options: {
    agent: { type: 'string' },
    date: { type: 'string' },
    stub: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (!values.agent || !values.date) {
  console.error('Dùng: npm run sim:session -- --agent <id> --date YYYY-MM-DD [--stub]');
  process.exit(1);
}

const cfg = loadConfig();
const client = createClient(cfg.databaseUrl);

try {
  const defs = await loadAgentDefs();
  const def = defs.find(d => d.id === values.agent);
  if (!def) {
    console.error(`Không tìm thấy agent '${values.agent}' trong config/agents.json.`);
    console.error(`Có sẵn: ${defs.map(d => d.id).join(', ')}`);
    process.exit(1);
  }

  // Đảm bảo agent tồn tại trong DB với vốn ban đầu.
  await createAgentsRepo(client).upsertMany([def]);

  const provider = createProvider({
    provider: values.stub ? 'stub' : def.provider,
    model: def.model,
  });

  const result = await runSession({
    client, agentId: def.id, tradeDate: values.date, provider, agentDef: def,
  });

  console.log(JSON.stringify({
    status: result.status,
    decisions: result.decisions.length,
    invalid: result.invalid?.length ?? 0,
    filled: result.results.filter(r => r.status === 'FILLED').length,
    rejected: result.results.filter(r => r.status === 'REJECTED').map(r => r.reason),
    close: result.close,
  }, null, 2));
} catch (err) {
  console.error(err.stack || err.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
```

- [ ] **Step 5: Thêm script vào root `package.json`**

```json
    "sim:session": "node packages/agent-runtime/src/cli.js",
```

- [ ] **Step 6: Chạy test**

```bash
node --test packages/agent-runtime/tests/session.test.js
node --test packages/agent-runtime/tests/session.test.js
npm test
```

Kỳ vọng: 5/5 hai lần; toàn suite xanh.

- [ ] **Step 7: Kiểm chứng end-to-end bằng CLI với stub**

```bash
npm run migrate
npm run sim:session -- --agent claude_value --date 2026-07-20 --stub
```

Kỳ vọng: in ra JSON có `status`, `close.nav`. Nếu `universe` hoặc `ohlcv_daily` rỗng (TradingView chưa từng chạy) thì `status` là `NO_DATA` — đó là hành vi đúng, không phải lỗi. Ghi lại kết quả thực tế vào báo cáo.

- [ ] **Step 8: Cập nhật `README.md`**

Thêm mục sau vào README:

```markdown
## Phase 2 — Simulation Engine

Một agent giao dịch giả lập trọn phiên, tuân thủ luật thị trường VN.

```bash
npm run sim:session -- --agent claude_value --date 2026-07-20 --stub
```

`--stub` dùng LLM giả tất định, không cần API key. Bỏ cờ này để chạy với
Claude thật (cần `ANTHROPIC_API_KEY` trong `.env`).

**Đơn vị giá:** TradingView báo giá cổ phiếu VN theo nghìn đồng (FPT = 118.5).
Engine tính bằng VND. Chuyển đổi xảy ra đúng một chỗ — `toVnd()` trong
`sim/vn_rules.js`, hệ số `PRICE_SCALE` (mặc định 1000, đổi được qua env).

**Luật đã mô phỏng:** T+2.5, lô chẵn 100, biên độ ±7%/±10%/±15%, bước giá
theo bậc, phí 0,15%, thuế bán 0,1%, trượt giá 0,1%.
```

- [ ] **Step 9: Commit**

```bash
git add packages/agent-runtime package.json README.md
git -c user.email=claudeai07@vhec.vn -c user.name="Claude" commit -m "feat(sim): end-to-end session runner and CLI"
```

---

## Điều kiện hoàn thành Phase 2

- [ ] `npm test` xanh toàn bộ (Phase 1: 114 test + Phase 2: ~98 test mới)
- [ ] Mỗi file test mới chạy riêng được và chạy hai lần liên tiếp vẫn xanh
- [ ] `npm run sim:session -- --agent claude_value --date <ngày> --stub` chạy hết, in JSON
- [ ] Bán cổ phiếu mua cùng ngày bị từ chối với lý do nêu T+2
- [ ] Lệnh ngoài biên độ bị từ chối và ghi `reject_reason` vào `orders`
- [ ] Mua rồi bán ngay cùng giá cho ra **lỗ** đúng bằng phí + thuế
- [ ] `grep -rn "tradingview-mcp" packages/agent-runtime/` không trả về gì
- [ ] Không file nào trong `packages/agent-runtime/src/` gọi DB mà bỏ qua repository layer

## Ghi chú cho Phase 3

- `exitPlan` đã được lưu vào `positions.exit_plan` nhưng **chưa ai đọc**. Phase 3 watchdog sẽ đối chiếu nó với `quote_tick` mỗi 5 phút.
- `engine.matchPending()` đã có nhưng session hiện chỉ gọi `submit` một lượt. Phase 3 sẽ gọi `matchPending` mỗi nhịp tick.
- `context.memory.lessons` đang là mảng rỗng — Phase 6 điền.
- `trade_outcomes` chưa được ghi. Phase 3 hoặc 6 cần ghép lệnh mua–bán thành round-trip để tính win rate.
- `orders.status` chưa có `PARTIALLY_FILLED`; engine hiện khớp toàn bộ hoặc không. Nếu Phase 3 cần khớp từng phần thì phải thêm giá trị vào CHECK constraint.
