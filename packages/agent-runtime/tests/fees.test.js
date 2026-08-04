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
