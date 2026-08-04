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

test('simStub mặc định false', () => {
  const cfg = loadConfig(BASE);
  assert.equal(cfg.simStub, false);
});

test('simStub đọc SIM_STUB=true', () => {
  const cfg = loadConfig({ ...BASE, SIM_STUB: 'true' });
  assert.equal(cfg.simStub, true);
});

test('config trả về là đóng băng', () => {
  const cfg = loadConfig(BASE);
  assert.throws(() => { cfg.databaseUrl = 'x'; }, TypeError);
});
