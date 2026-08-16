import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import {
  createUniverseRepo, createOpsRepo, createEventsRepo, createFundamentalsRepo,
} from '@stockagents/db';
import { collectFundamentals, collectFundamentalsBatch } from '../src/collectors/fundamentals.js';
import { runIngestFundamentals } from '../src/jobs/ingest_fundamentals.js';

const silent = { info() {}, warn() {}, error() {} };

const ratioRow = (yearReport, quarter, pe) => ({
  yearReport, quarter, pe, pb: 2.5, ps: 1.1, roe: 0.2, roa: 0.1,
  dividendYield: 0.02, debtToEquity: 0.5, currentRatio: 1.4, grossMargin: 0.3,
  marketCap: 1e13,
});

function fakeFetchOk(rows) {
  return async () => ({ ok: true, json: async () => ({ data: rows }) });
}

/* ---------- collectFundamentals ---------- */

test('collectFundamentals lấy đúng bản MỚI NHẤT, không phải phần tử cuối mảng', async () => {
  // Cố tình để phần tử "mới nhất theo yearReport/quarter" KHÔNG nằm cuối
  // mảng — hàm không được tin thứ tự trả về từ API.
  const rows = [
    ratioRow(2026, 2, 11.6),
    ratioRow(2025, 4, 20),
    ratioRow(2026, 1, 15),
  ];
  const r = await collectFundamentals('HOSE:FPT', fakeFetchOk(rows));
  assert.equal(r.yearReport, 2026);
  assert.equal(r.quarter, 2);
  assert.equal(r.pe, 11.6);
});

test('collectFundamentals chỉ giữ field dùng để phân tích, bỏ field riêng ngân hàng', async () => {
  const r = await collectFundamentals('HOSE:FPT', fakeFetchOk([ratioRow(2026, 2, 11.6)]));
  assert.ok(!('car' in r), 'field chỉ có nghĩa với ngân hàng không nên lọt vào context');
  assert.ok(!('npl' in r));
  assert.equal(r.roe, 0.2);
  assert.equal(r.marketCap, 1e13);
});

test('collectFundamentals bóc tiền tố sàn khỏi mã khi gọi API (VCI nhận ticker trần)', async () => {
  let seenUrl = null;
  const fetchImpl = async (url) => { seenUrl = url; return { ok: true, json: async () => ({ data: [ratioRow(2026, 2, 11.6)] }) }; };
  await collectFundamentals('HOSE:FPT', fetchImpl);
  assert.match(seenUrl, /\/FPT\/statistics-financial$/);
});

test('collectFundamentals ném lỗi rõ khi HTTP lỗi', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => collectFundamentals('HOSE:FPT', fetchImpl), /HTTP 500/);
});

test('collectFundamentals ném lỗi rõ khi data rỗng, không trả về giá trị rác', async () => {
  await assert.rejects(() => collectFundamentals('HOSE:FPT', fakeFetchOk([])), /không có dữ liệu/);
});

test('collectFundamentalsBatch một mã lỗi không chặn các mã còn lại', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call++;
    if (call === 1) return { ok: false, status: 500 };
    return { ok: true, json: async () => ({ data: [ratioRow(2026, 2, 8.2)] }) };
  };
  const { snapshots, errors } = await collectFundamentalsBatch(['HOSE:FPT', 'HOSE:VCB'], fetchImpl);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].symbol, 'HOSE:FPT');
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].symbol, 'HOSE:VCB');
});

/* ---------- runIngestFundamentals ---------- */

let client, repos;
const TABLES = ['fundamentals_snapshot', 'ingest_errors', 'event_log', 'universe'];

before(async () => {
  client = await withTestDb();
  repos = {
    universe: createUniverseRepo(client), ops: createOpsRepo(client),
    events: createEventsRepo(client), fundamentals: createFundamentalsRepo(client),
  };
});
beforeEach(async () => {
  await resetTables(client, TABLES);
  await repos.universe.upsertMany([
    { symbol: 'HOSE:FPT', exchange: 'HOSE' },
    { symbol: 'HOSE:VCB', exchange: 'HOSE' },
  ]);
});
after(async () => { await client.close(); });

test('runIngestFundamentals ghi snapshot cho mọi mã thành công', async () => {
  const summary = await runIngestFundamentals({
    repos, logger: silent, fetchImpl: fakeFetchOk([ratioRow(2026, 2, 11.6)]),
  });
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 0);

  const map = await repos.fundamentals.getLatestForSymbols(['HOSE:FPT', 'HOSE:VCB']);
  assert.equal(map.get('HOSE:FPT').pe, 11.6);
});

test('runIngestFundamentals ghi ingest_errors và vẫn hoàn tất khi một mã lỗi', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call++;
    if (call === 1) return { ok: false, status: 500 };
    return { ok: true, json: async () => ({ data: [ratioRow(2026, 2, 8.2)] }) };
  };
  const summary = await runIngestFundamentals({ repos, logger: silent, fetchImpl });
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 1);

  const { rows } = await client.query(`SELECT symbol FROM ingest_errors WHERE job = 'ingest_fundamentals'`);
  assert.equal(rows.length, 1);
});

test('runIngestFundamentals phát sự kiện fundamentals.ingested', async () => {
  await runIngestFundamentals({ repos, logger: silent, fetchImpl: fakeFetchOk([ratioRow(2026, 2, 11.6)]) });
  const { events } = { events: await repos.events.getEventsSince(0, 10) };
  const e = events.find(e => e.type === 'fundamentals.ingested');
  assert.ok(e);
  assert.equal(e.payload.succeeded, 2);
});

test('runIngestFundamentals với universe rỗng trả về 0/0, không lỗi', async () => {
  await client.query('DELETE FROM universe');
  const summary = await runIngestFundamentals({ repos, logger: silent, fetchImpl: fakeFetchOk([]) });
  assert.deepEqual(summary, { succeeded: 0, failed: 0 });
});
