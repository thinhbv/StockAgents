import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sma, ema, rsi, macd, bollinger, atr, computeIndicators,
} from '../src/collectors/indicators_calc.js';

/**
 * Chuỗi giá chuẩn của Wilder dùng trong sách giáo khoa RSI — có giá trị
 * tham chiếu đã biết, nên test này thực sự kiểm chứng công thức chứ không
 * chỉ khẳng định code trả về đúng cái nó vừa tính.
 */
const WILDER = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
  45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
  46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57,
];

const bar = (c, h = c + 1, l = c - 1, v = 1000) => ({ open: c, high: h, low: l, close: c, volume: v });
const barsOf = (closes) => closes.map(c => bar(c));

/* ---------- SMA / EMA ---------- */

test('sma trung bình đúng cửa sổ cuối', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 3), 4);      // (3+4+5)/3
  assert.equal(sma([10, 20], 2), 15);
});

test('sma trả null khi chưa đủ dữ liệu', () => {
  assert.equal(sma([1, 2], 5), null);
});

test('ema phản ứng nhanh hơn sma với biến động gần đây', () => {
  // Chuỗi tăng TUYẾN TÍNH thì EMA (mồi bằng SMA) hội tụ đúng bằng SMA — đó
  // là tính chất toán học, không phải lỗi. Muốn kiểm chứng độ nhạy thì phải
  // dùng chuỗi phẳng rồi nhảy.
  const jump = [...new Array(15).fill(100), 130];
  assert.ok(ema(jump, 5) > sma(jump, 5),
    `EMA ${ema(jump, 5)} phải cao hơn SMA ${sma(jump, 5)} sau cú nhảy`);
});

test('ema và sma trùng nhau trên chuỗi tăng tuyến tính — tính chất, không phải lỗi', () => {
  const linear = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(ema(linear, 5), sma(linear, 5));
});

test('ema của chuỗi hằng bằng chính hằng số đó', () => {
  assert.equal(ema([5, 5, 5, 5, 5, 5], 3), 5);
});

/* ---------- RSI ---------- */

test('rsi khớp giá trị tham chiếu của Wilder', () => {
  // Giá trị chuẩn cho chuỗi này là ~70,5 sau 15 bar đầu.
  const v = rsi(WILDER.slice(0, 15), 14);
  assert.ok(Math.abs(v - 70.53) < 0.5, `kỳ vọng ~70,53 nhận ${v}`);
});

test('rsi bằng 100 khi giá chỉ tăng, và thấp khi chỉ giảm', () => {
  const up = Array.from({ length: 20 }, (_, i) => 100 + i);
  const down = Array.from({ length: 20 }, (_, i) => 100 - i);
  assert.equal(rsi(up, 14), 100);
  assert.equal(rsi(down, 14), 0);
});

test('rsi của chuỗi đi ngang là 50, không phải NaN', () => {
  assert.equal(rsi(new Array(20).fill(50), 14), 50);
});

test('rsi trả null khi chưa đủ bar', () => {
  assert.equal(rsi([1, 2, 3], 14), null);
});

test('rsi luôn nằm trong 0..100', () => {
  const noisy = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 10);
  const v = rsi(noisy, 14);
  assert.ok(v >= 0 && v <= 100, `nhận ${v}`);
});

/* ---------- MACD ---------- */

test('macd trả đủ ba thành phần và histogram bằng hiệu hai đường', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
  const m = macd(closes);
  assert.ok(Number.isFinite(m.macd) && Number.isFinite(m.macdSignal));
  assert.ok(Math.abs(m.macdHist - (m.macd - m.macdSignal)) < 1e-6);
});

test('macd dương khi xu hướng tăng, âm khi xu hướng giảm', () => {
  const up = Array.from({ length: 60 }, (_, i) => 100 + i);
  const down = Array.from({ length: 60 }, (_, i) => 200 - i);
  assert.ok(macd(up).macd > 0);
  assert.ok(macd(down).macd < 0);
});

test('macd trả null khi chưa đủ bar', () => {
  assert.equal(macd(Array.from({ length: 20 }, (_, i) => i)), null);
});

/* ---------- Bollinger ---------- */

test('bollinger: basis là SMA và dải đối xứng quanh nó', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + (i % 5));
  const b = bollinger(closes);
  assert.equal(b.bbBasis, sma(closes, 20));
  assert.ok(Math.abs((b.bbUpper - b.bbBasis) - (b.bbBasis - b.bbLower)) < 1e-6);
});

test('bollinger của chuỗi hằng có dải rộng bằng 0', () => {
  const b = bollinger(new Array(25).fill(100));
  assert.equal(b.bbUpper, 100);
  assert.equal(b.bbLower, 100);
});

test('chuỗi biến động mạnh cho dải rộng hơn chuỗi ổn định', () => {
  const calm = Array.from({ length: 25 }, (_, i) => 100 + (i % 2));
  const wild = Array.from({ length: 25 }, (_, i) => 100 + (i % 2) * 30);
  assert.ok(bollinger(wild).bbUpper - bollinger(wild).bbLower >
            bollinger(calm).bbUpper - bollinger(calm).bbLower);
});

/* ---------- ATR ---------- */

test('atr của bar có biên độ cố định bằng chính biên độ đó', () => {
  const bars = Array.from({ length: 20 }, () => ({ high: 102, low: 100, close: 101 }));
  assert.equal(atr(bars, 14), 2);
});

test('atr tăng khi biên độ dao động rộng ra', () => {
  const narrow = Array.from({ length: 20 }, () => ({ high: 101, low: 100, close: 100.5 }));
  const wide = Array.from({ length: 20 }, () => ({ high: 110, low: 100, close: 105 }));
  assert.ok(atr(wide, 14) > atr(narrow, 14));
});

test('atr tính cả khoảng nhảy giá (gap) qua true range', () => {
  const bars = [
    { high: 100, low: 99, close: 99.5 },
    ...Array.from({ length: 19 }, () => ({ high: 150, low: 149, close: 149.5 })),
  ];
  assert.ok(atr(bars, 14) > 1, 'gap phải làm ATR lớn hơn biên độ trong ngày');
});

/* ---------- Gộp ---------- */

test('computeIndicators trả đủ mọi khoá Phase 2 và Phase 5 đang đọc', () => {
  const bars = barsOf(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5));
  const out = computeIndicators(bars);

  for (const key of ['rsi14', 'ma20', 'macd', 'macdSignal', 'macdHist',
                     'bbBasis', 'bbUpper', 'bbLower', 'atr14', 'volume']) {
    assert.ok(Number.isFinite(out[key]), `thiếu hoặc sai khoá ${key}: ${out[key]}`);
  }
});

test('computeIndicators đủ bốn khoá BẮT BUỘC mà ingest kiểm tra', () => {
  const bars = barsOf(Array.from({ length: 60 }, (_, i) => 100 + i * 0.3));
  const out = computeIndicators(bars);
  for (const key of ['rsi14', 'macd', 'bbBasis', 'atr14']) {
    assert.ok(Number.isFinite(out[key]), `khoá bắt buộc ${key} phải có`);
  }
});

test('ít bar thì trả khoá nào tính được, không ném lỗi và không trả NaN', () => {
  const out = computeIndicators(barsOf([100, 101, 102]));
  assert.doesNotThrow(() => computeIndicators(barsOf([100])));
  for (const [k, v] of Object.entries(out)) {
    assert.ok(Number.isFinite(v), `${k} = ${v} không phải số hữu hạn`);
  }
});

test('mảng rỗng trả object rỗng', () => {
  assert.deepEqual(computeIndicators([]), {});
});

test('mọi giá trị trả về đều là số hữu hạn, không bao giờ NaN', () => {
  const bars = barsOf(Array.from({ length: 60 }, () => 100));   // hoàn toàn phẳng
  const out = computeIndicators(bars);
  for (const [k, v] of Object.entries(out)) {
    assert.ok(Number.isFinite(v), `${k} = ${v} — chuỗi phẳng không được sinh NaN`);
  }
});
