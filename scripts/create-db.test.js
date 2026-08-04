import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitUrl } from './create-db.mjs';

/**
 * `splitUrl` là phần duy nhất của create-db có thể sai âm thầm: nếu nó dựng
 * URL quản trị sai, script sẽ cố tạo database TRONG chính database chưa tồn
 * tại, hoặc tệ hơn là kết nối đúng nhưng đọc nhầm tên. Không test được đường
 * `CREATE DATABASE` mà không thật sự tạo database, nên tách phần thuần ra.
 */

test('tách đúng tên database và trỏ URL quản trị về postgres', () => {
  const r = splitUrl('postgres://postgres:pw@localhost:5432/stockagents', 'DATABASE_URL');
  assert.equal(r.name, 'stockagents');
  assert.equal(new URL(r.adminUrl).pathname, '/postgres');
});

test('giữ nguyên host, cổng, user và mật khẩu khi đổi sang URL quản trị', () => {
  const r = splitUrl('postgres://bob:s3cret@db.local:6543/stockagents_test', 'X');
  const u = new URL(r.adminUrl);
  assert.equal(u.hostname, 'db.local');
  assert.equal(u.port, '6543');
  assert.equal(u.username, 'bob');
  assert.equal(u.password, 's3cret');
});

test('mật khẩu có ký tự đặc biệt đã mã hoá không bị đổi qua vòng chuyển', () => {
  // '@' trong mật khẩu phải ở dạng %40, nếu không URL đã hỏng từ đầu.
  const r = splitUrl('postgres://postgres:p%40ss%3Aword@localhost:5432/db1', 'X');
  assert.equal(new URL(r.adminUrl).password, 'p%40ss%3Aword');
  assert.equal(decodeURIComponent(new URL(r.adminUrl).password), 'p@ss:word');
});

test('tên database có ký tự cần escape được giải mã đúng', () => {
  const r = splitUrl('postgres://u:p@h:5432/my%20db', 'X');
  assert.equal(r.name, 'my db');
});

test('URL không có tên database thì báo lỗi, không âm thầm dùng chuỗi rỗng', () => {
  assert.throws(() => splitUrl('postgres://u:p@localhost:5432/', 'DATABASE_URL'),
    /DATABASE_URL thiếu tên database/);
});

test('chuỗi không phải URL thì nêu rõ tên biến sai', () => {
  assert.throws(() => splitUrl('không-phải-url', 'DATABASE_URL_TEST'),
    /DATABASE_URL_TEST không phải URL hợp lệ/);
});

test('URL gốc không bị sửa đổi', () => {
  const original = 'postgres://u:p@localhost:5432/stockagents';
  splitUrl(original, 'X');
  assert.equal(original, 'postgres://u:p@localhost:5432/stockagents');
});
