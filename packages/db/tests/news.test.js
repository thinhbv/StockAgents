import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import { createNewsRepo } from '../src/repositories/news.js';

let client, news;

before(async () => {
  client = await withTestDb();
  news = createNewsRepo(client);
});
beforeEach(async () => {
  await resetTables(client, ['news_items', 'universe']);
  await client.query(`INSERT INTO universe (symbol, exchange) VALUES ('HOSE:FPT', 'HOSE')`);
});
after(async () => { await client.close(); });

test('gặp lại bài đã lưu thì vá được ngày đăng và mã còn thiếu', async () => {
  // Bản ghi cũ: ghi khi nguồn chưa đọc được ngày nên published_at và symbol đều null.
  await news.upsertMany([{ url: 'https://x/1', source: 'cafef', title: 'Tin cũ đã lưu' }]);
  await news.upsertMany([{ url: 'https://x/1', source: 'cafef', title: 'Tin cũ đã lưu',
    symbol: 'HOSE:FPT', publishedAt: '2026-10-18T07:00:00+07:00' }]);

  const [row] = await news.listRecent({ limit: 10 });
  assert.equal(row.symbol, 'HOSE:FPT');
  assert.equal(new Date(row.publishedAt).toISOString(), '2026-10-18T00:00:00.000Z');
});

test('gặp lại với ngày null không xoá ngày đã có', async () => {
  await news.upsertMany([{ url: 'https://x/2', source: 'vnexpress', title: 'Tin có ngày',
    publishedAt: '2026-10-18T07:00:00+07:00' }]);
  await news.upsertMany([{ url: 'https://x/2', source: 'vnexpress', title: 'Tin có ngày' }]);

  const [row] = await news.listRecent({ limit: 10 });
  assert.ok(row.publishedAt, 'ngày đã có không được bị ghi đè bằng null');
});
