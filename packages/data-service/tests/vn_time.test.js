import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toVnDate, nowVnDate, isTradingDay, isTradingWindow } from '../src/lib/vn_time.js';

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

test('toVnDate từ chối giá trị mili-giây (đơn vị sai) thay vì âm thầm ra ngày sai', () => {
  // Date.now()-style ms timestamp — cỡ 13 chữ số, ngoài khoảng epoch-giây hợp lệ
  assert.throws(() => toVnDate(1784592000000), /toVnDate/);
});

test('toVnDate vẫn chạy đúng với giá trị giây bình thường', () => {
  assert.equal(toVnDate(1784592000), '2026-07-21');
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

// 2026-07-20 là thứ Hai, 2026-07-25 là thứ Bảy (đã xác nhận ở test trên).
// Dùng offset +07:00 tường minh — giờ Việt Nam không có DST nên offset này
// luôn đúng, và giá trị mong đợi không phụ thuộc đồng hồ máy chạy test.
test('isTradingWindow: trước 09:20 là false', () => {
  assert.equal(isTradingWindow(new Date('2026-07-20T09:15:00+07:00')), false);
});

test('isTradingWindow: đúng 09:20 là true (biên dưới phiên sáng, inclusive)', () => {
  assert.equal(isTradingWindow(new Date('2026-07-20T09:20:00+07:00')), true);
});

test('isTradingWindow: 11:29 vẫn trong phiên sáng, true', () => {
  assert.equal(isTradingWindow(new Date('2026-07-20T11:29:00+07:00')), true);
});

test('isTradingWindow: đúng 11:30 là true (biên trên phiên sáng, inclusive)', () => {
  assert.equal(isTradingWindow(new Date('2026-07-20T11:30:00+07:00')), true);
});

test('isTradingWindow: 12:00 đang nghỉ trưa, false', () => {
  assert.equal(isTradingWindow(new Date('2026-07-20T12:00:00+07:00')), false);
});

test('isTradingWindow: đúng 13:00 là true (biên dưới phiên chiều, inclusive)', () => {
  assert.equal(isTradingWindow(new Date('2026-07-20T13:00:00+07:00')), true);
});

test('isTradingWindow: đúng 14:30 là true (biên trên phiên chiều, inclusive)', () => {
  assert.equal(isTradingWindow(new Date('2026-07-20T14:30:00+07:00')), true);
});

test('isTradingWindow: 14:45 sau giờ đóng cửa, false', () => {
  assert.equal(isTradingWindow(new Date('2026-07-20T14:45:00+07:00')), false);
});

test('isTradingWindow: thứ Bảy trong giờ giao dịch vẫn false vì không phải ngày giao dịch', () => {
  assert.equal(isTradingWindow(new Date('2026-07-25T10:00:00+07:00')), false);
});

test('isTradingDay từ chối chuỗi không phải ngày hợp lệ thay vì âm thầm trả về false', () => {
  assert.throws(() => isTradingDay('garbage'), /isTradingDay/);
  assert.throws(() => isTradingDay('2026-13-40'), /isTradingDay/);
  assert.throws(() => isTradingDay(null), /isTradingDay/);
  assert.throws(() => isTradingDay(undefined), /isTradingDay/);
});

test('isTradingDay loại ngày nghỉ lễ được truyền vào', () => {
  // Tết Nguyên đán rơi vào thứ Hai — vẫn là ngày làm việc theo lịch tuần,
  // nhưng sàn đóng cửa. Không có bảng lễ thì hệ thống sẽ ingest vào ngày
  // không có dữ liệu và tưởng là mất kết nối.
  assert.equal(isTradingDay('2026-07-20'), true);
  assert.equal(isTradingDay('2026-07-20', ['2026-07-20']), false);
  assert.equal(isTradingDay('2026-07-20', new Set(['2026-07-20'])), false);
});

test('ngày lễ không liên quan không ảnh hưởng', () => {
  assert.equal(isTradingDay('2026-07-20', ['2026-01-01']), true);
});
