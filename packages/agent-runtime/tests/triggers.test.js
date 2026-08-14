import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRIGGER_TYPES, DEBOUNCE_MINUTES, evaluateTriggers, isDebounced,
  evaluateUniverseAlerts, UNIVERSE_MOVE_THRESHOLD_PCT,
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

test('evaluateUniverseAlerts: PRICE_MOVE nổ khi mã chưa giữ tăng/giảm mạnh so với tham chiếu', () => {
  const t = evaluateUniverseAlerts({
    symbols: ['HOSE:VNM'],
    tickPriceMap: new Map([['HOSE:VNM', 106_000]]),
    refPriceMap: new Map([['HOSE:VNM', 100_000]]),
    newsSentimentMap: new Map(),
  });
  assert.equal(t.length, 1);
  assert.equal(t[0].type, 'PRICE_MOVE');
  assert.equal(t[0].changePct, 6);
});

test('evaluateUniverseAlerts: không nổ khi biến động dưới ngưỡng', () => {
  const t = evaluateUniverseAlerts({
    symbols: ['HOSE:VNM'],
    tickPriceMap: new Map([['HOSE:VNM', 103_000]]),
    refPriceMap: new Map([['HOSE:VNM', 100_000]]),
    newsSentimentMap: new Map(),
  });
  assert.deepEqual(t, []);
});

test('evaluateUniverseAlerts: NEWS_ALERT nổ với tin rất xấu dù giá đứng yên', () => {
  const t = evaluateUniverseAlerts({
    symbols: ['HOSE:VNM'],
    tickPriceMap: new Map([['HOSE:VNM', 100_000]]),
    refPriceMap: new Map([['HOSE:VNM', 100_000]]),
    newsSentimentMap: new Map([['HOSE:VNM', -0.9]]),
  });
  assert.ok(t.some(x => x.type === 'NEWS_ALERT'));
});

test('evaluateUniverseAlerts: thiếu giá tham chiếu thì bỏ qua mã đó, không đoán bừa', () => {
  const t = evaluateUniverseAlerts({
    symbols: ['HOSE:VNM'],
    tickPriceMap: new Map([['HOSE:VNM', 200_000]]),
    refPriceMap: new Map(),
    newsSentimentMap: new Map(),
  });
  assert.deepEqual(t, []);
});

test('UNIVERSE_MOVE_THRESHOLD_PCT mặc định là 5', () => {
  assert.equal(UNIVERSE_MOVE_THRESHOLD_PCT, 5);
});
