import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb } from '../../../tests/helpers/db.js';

// withTestDb() TRUNCATE/DROP không điều kiện trong các bài test khác — DB thật
// và DB test chỉ khác nhau hậu tố `_test`. Bài test này xác nhận nó từ chối
// NGAY (trước khi mở kết nối) khi DATABASE_URL_TEST không trỏ tới một
// database `_test`, để một lỗi gõ nhầm trong .env không thể xóa DB thật.
test('withTestDb từ chối database không kết thúc bằng _test', async () => {
  const original = process.env.DATABASE_URL_TEST;
  process.env.DATABASE_URL_TEST = 'postgres://postgres:123456@localhost:5432/stockagents';
  try {
    await assert.rejects(withTestDb(), /phải kết thúc.*_test/);
  } finally {
    process.env.DATABASE_URL_TEST = original;
  }
});

test('withTestDb chấp nhận database kết thúc bằng _test', async () => {
  // Không xác nhận gì thêm ở đây ngoài việc guard không ném lỗi cho tên hợp lệ —
  // các bài test khác (vd. migrate.test.js, ingest_prices.test.js) đã tự kết
  // nối và chạy migration thành công, tức đường đi này đã được phủ.
  const client = await withTestDb();
  await client.close();
});
