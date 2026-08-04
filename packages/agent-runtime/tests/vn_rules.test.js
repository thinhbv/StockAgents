import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE_SCALE, LOT_SIZE, toVnd, assertPlausibleVndPrice, parseSymbol,
  BAND_PCT, priceBand, tickSize, roundToTick, normalizeQty, settlementDate,
} from '../src/sim/vn_rules.js';

test('toVnd giữ nguyên giá TradingView — VN đã báo bằng VND', () => {
  // Kiểm chứng trên dữ liệu thật: FPT 67.000, VCB 14.400 — đây là VND,
  // không phải nghìn đồng.
  assert.equal(PRICE_SCALE, 1);
  assert.equal(toVnd(67000), 67000);
  assert.equal(toVnd(14400), 14400);
});

test('toVnd làm tròn về đồng nguyên', () => {
  assert.equal(toVnd(67000.4), 67000);
  assert.equal(Number.isInteger(toVnd(21850.7)), true);
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
  assert.equal(settlementDate('2026-07-20', ['2026-07-22']), '2026-07-23');
});

test('settlementDate từ chối ngày sai định dạng', () => {
  assert.throws(() => settlementDate('20/07/2026'), /settlementDate/);
});
