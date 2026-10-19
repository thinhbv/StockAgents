import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePublishedAt } from '../src/news/sources.js';

test('đọc ngày từ meta article:published_time và giữ đúng múi giờ', () => {
  const html = '<head><meta property="article:published_time" content="2026-10-18T07:34:10+07:00"></head>';
  assert.equal(parsePublishedAt(html), '2026-10-18T00:34:10.000Z');
});

test('múi giờ dạng +0700 (không có dấu hai chấm) vẫn đọc được', () => {
  const html = '<meta name="pubdate" content="2026-10-18T20:16:58+0700">';
  assert.equal(parsePublishedAt(html), '2026-10-18T13:16:58.000Z');
});

test('dấu + của múi giờ bị mã hoá thành thực thể HTML vẫn đọc được (vneconomy)', () => {
  const html = '<meta name="article:published_time" content="2026-09-19T12:23:34&#x2B;07:00">';
  assert.equal(parsePublishedAt(html), '2026-09-19T05:23:34.000Z');
});

test('chuỗi không có múi giờ được hiểu là giờ Việt Nam', () => {
  const html = '<meta itemprop="datePublished" content="2026-10-18T00:04:00">';
  assert.equal(parsePublishedAt(html), '2026-10-17T17:04:00.000Z');
});

test('đọc được thẻ <time datetime> khi không có meta', () => {
  const html = '<time datetime="2026-10-18T08:50:00+07:00">8h50</time>';
  assert.equal(parsePublishedAt(html), '2026-10-18T01:50:00.000Z');
});

test('trang không có ngày thì trả null, không đoán', () => {
  assert.equal(parsePublishedAt('<html><body>không có gì</body></html>'), null);
});
