import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import {
  createUniverseRepo, createNewsRepo, createOpsRepo, createEventsRepo,
} from '@stockagents/db';
import { scoreSentiment, detectSymbol } from '../src/news/sentiment.js';
import { runIngestNews } from '../src/jobs/ingest_news.js';

const silent = { info() {}, warn() {}, error() {} };
let client, repos;
const TABLES = ['news_items', 'ingest_errors', 'event_log', 'universe'];

before(async () => {
  client = await withTestDb();
  repos = {
    universe: createUniverseRepo(client), news: createNewsRepo(client),
    ops: createOpsRepo(client), events: createEventsRepo(client),
  };
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await repos.universe.upsertMany([
    { symbol: 'HOSE:FPT', exchange: 'HOSE' },
    { symbol: 'HOSE:HPG', exchange: 'HOSE' },
  ]);
});
after(async () => { await client.close(); });

/* ---------- Chấm điểm cảm xúc ---------- */

test('tin xấu rõ ràng cho điểm âm', () => {
  assert.ok(scoreSentiment('Chủ tịch HPG bị khởi tố, cổ phiếu giảm sàn') < 0);
});

test('tin tốt rõ ràng cho điểm dương', () => {
  assert.ok(scoreSentiment('FPT trúng thầu dự án lớn, lãi vượt kế hoạch') > 0);
});

test('tin trung tính cho 0, không phải null', () => {
  assert.equal(scoreSentiment('Lịch chốt quyền họp đại hội cổ đông thường niên'), 0);
});

test('chuỗi rỗng trả null để phân biệt với trung tính', () => {
  assert.equal(scoreSentiment(''), null);
  assert.equal(scoreSentiment(null), null);
});

test('điểm luôn nằm trong khoảng -1..1', () => {
  const hot = 'giảm sàn bán tháo lao dốc thua lỗ phá sản khởi tố';
  const s = scoreSentiment(hot);
  assert.ok(s >= -1 && s <= 1, `nhận ${s}`);
});

test('tin vừa tốt vừa xấu thì trung hoà chứ không nghiêng hẳn', () => {
  const s = scoreSentiment('Doanh nghiệp thua lỗ nhưng vừa trúng thầu dự án mới');
  assert.ok(Math.abs(s) < 0.6, `kỳ vọng gần trung tính, nhận ${s}`);
});

/* ---------- Nhận diện mã ---------- */

test('nhận ra mã được nhắc trong tiêu đề', () => {
  assert.equal(detectSymbol('FPT công bố kết quả quý 2', ['HOSE:FPT', 'HOSE:HPG']), 'HOSE:FPT');
});

test('không khớp nhầm khi mã nằm lọt trong một từ khác', () => {
  assert.equal(detectSymbol('CHPGROUP mở rộng nhà máy', ['HOSE:HPG']), null,
    'HPG không được khớp bên trong CHPGROUP');
});

test('tin chung không gắn mã nào', () => {
  assert.equal(detectSymbol('VN-Index tăng điểm phiên đầu tuần', ['HOSE:FPT']), null);
});

/* ---------- Repository ---------- */

test('cùng một URL đăng lại không tạo bản ghi trùng', async () => {
  const item = { source: 'cafef', url: 'https://x/1', title: 'Tin A' };
  await repos.news.upsertMany([item]);
  await repos.news.upsertMany([{ ...item, title: 'Tin A (đã sửa)' }]);

  const list = await repos.news.listRecent({});
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Tin A (đã sửa)');
});

test('lọc tin theo mã', async () => {
  await repos.news.upsertMany([
    { source: 's', url: 'https://x/1', title: 'A', symbol: 'HOSE:FPT' },
    { source: 's', url: 'https://x/2', title: 'B', symbol: 'HOSE:HPG' },
  ]);
  const list = await repos.news.listRecent({ symbol: 'HOSE:FPT' });
  assert.deepEqual(list.map(n => n.title), ['A']);
});

test('worstSentimentBySymbol lấy tin TỆ NHẤT, không lấy trung bình', async () => {
  const since = new Date(Date.now() - 86_400_000);
  await repos.news.upsertMany([
    { source: 's', url: 'https://x/1', title: 'rất xấu', symbol: 'HOSE:FPT', sentiment: -0.9, publishedAt: new Date() },
    { source: 's', url: 'https://x/2', title: 'bình thường', symbol: 'HOSE:FPT', sentiment: 0, publishedAt: new Date() },
    { source: 's', url: 'https://x/3', title: 'bình thường', symbol: 'HOSE:FPT', sentiment: 0, publishedAt: new Date() },
  ]);

  const map = await repos.news.worstSentimentBySymbol({ since });
  assert.equal(map.get('HOSE:FPT'), -0.9,
    'một tin rất xấu không được ba tin trung tính pha loãng');
});

/* ---------- Job ingest ---------- */

test('ingest gom tin từ nhiều nguồn và tự gắn mã', async () => {
  const sources = {
    cafef: async () => [{ title: 'FPT lãi vượt kế hoạch', url: 'https://c/1' }],
    vnexpress: async () => [{ title: 'HPG bị xử phạt vi phạm môi trường', url: 'https://v/1' }],
  };
  const r = await runIngestNews({ repos, sources, logger: silent });

  assert.equal(r.fetched, 2);
  assert.equal(r.saved, 2);
  const list = await repos.news.listRecent({});
  assert.deepEqual(list.map(n => n.symbol).sort(), ['HOSE:FPT', 'HOSE:HPG']);
});

test('một nguồn chết không chặn các nguồn còn lại', async () => {
  const sources = {
    tot: async () => [{ title: 'FPT tăng trưởng', url: 'https://t/1' }],
    hong: async () => { throw new Error('HTTP 503'); },
  };
  const r = await runIngestNews({ repos, sources, logger: silent });

  assert.equal(r.saved, 1);
  assert.deepEqual(r.failedSources, ['hong']);
  const { rows } = await client.query(`SELECT count(*)::int n FROM ingest_errors WHERE job='ingest_news'`);
  assert.equal(rows[0].n, 1);
});

test('mọi nguồn chết thì vẫn kết thúc êm, không ném lỗi', async () => {
  const sources = { a: async () => { throw new Error('x'); }, b: async () => { throw new Error('y'); } };
  const r = await runIngestNews({ repos, sources, logger: silent });
  assert.equal(r.saved, 0);
  assert.equal(r.failedSources.length, 2);
});

test('ingest phát sự kiện news.ingested', async () => {
  await runIngestNews({
    repos, sources: { s: async () => [{ title: 'FPT tốt', url: 'https://s/1' }] }, logger: silent,
  });
  const events = await repos.events.getEventsSince(0, 20);
  const e = events.find(x => x.type === 'news.ingested');
  assert.ok(e);
  assert.equal(e.payload.saved, 1);
});

test('tin thiếu url hoặc tiêu đề bị bỏ qua, không ghi rác', async () => {
  const sources = {
    s: async () => [
      { title: 'không có url' },
      { url: 'https://s/2' },
      { title: 'đủ cả hai', url: 'https://s/3' },
    ],
  };
  const r = await runIngestNews({ repos, sources, logger: silent });
  assert.equal(r.fetched, 1);
});

test('decodeEntities giải mã thực thể HTML của nguồn tin VN', async () => {
  const { decodeEntities } = await import('../src/news/sentiment.js');
  assert.equal(decodeEntities('đ&#243;n nhận'), 'đón nhận');
  assert.equal(decodeEntities('gi&#225; ch&#224;o s&#224;n'), 'giá chào sàn');
  assert.equal(decodeEntities('A &amp; B'), 'A & B');
  assert.equal(decodeEntities('kh&#244;ng c&#243; g&#236;'), 'không có gì');
});

test('chấm điểm cảm xúc chạy SAU khi giải mã, nếu không từ có dấu không khớp', async () => {
  const { decodeEntities } = await import('../src/news/sentiment.js');
  // Mọi từ khoá tiêu cực đều ở dạng thực thể: 'bán tháo' -> 'b&#225;n th&#225;o'
  const raw = 'C&#244;ng ty n&#224;y b&#225;n th&#225;o cổ phiếu';
  assert.equal(scoreSentiment(raw), 0, 'chuỗi còn thực thể thì không khớp từ nào');
  assert.ok(scoreSentiment(decodeEntities(raw)) < 0, 'giải mã rồi mới bắt được tin xấu');
});

test('ingest lưu tiêu đề đã giải mã, không lưu thực thể thô', async () => {
  const sources = { s: async () => [{ title: 'FPT đ&#243;n tin t&#237;ch cực', url: 'https://s/9' }] };
  await runIngestNews({ repos, sources, logger: silent });

  const [n] = await repos.news.listRecent({});
  assert.equal(/&#\d+;/.test(n.title), false, `tiêu đề còn thực thể thô: ${n.title}`);
  assert.match(n.title, /đón/);
});
