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
  // collectFundamentals giờ gọi thêm 2 endpoint doanh thu/lợi nhuận song song
  // với endpoint tỷ lệ — ghi lại MỌI url đã gọi thay vì chỉ url cuối cùng.
  const seenUrls = [];
  const fetchImpl = async (url) => {
    seenUrls.push(url);
    return { ok: true, json: async () => ({ data: [ratioRow(2026, 2, 11.6)] }) };
  };
  await collectFundamentals('HOSE:FPT', fetchImpl);
  assert.ok(seenUrls.some(u => /\/FPT\/statistics-financial$/.test(u)));
});

test('collectFundamentals ném lỗi rõ khi HTTP lỗi', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => collectFundamentals('HOSE:FPT', fetchImpl), /HTTP 500/);
});

test('collectFundamentals ném lỗi rõ khi data rỗng, không trả về giá trị rác', async () => {
  await assert.rejects(() => collectFundamentals('HOSE:FPT', fakeFetchOk([])), /không có dữ liệu/);
});

/* ---------- incomeStatement (doanh thu/lợi nhuận tuyệt đối) ---------- */

const metricsBody = (fields) => ({ data: { INCOME_STATEMENT: fields } });
const F_NONBANK = [
  { field: 'isa3', titleVi: 'Doanh thu thuần' },
  { field: 'isa20', titleVi: 'Lãi/(lỗ) thuần sau thuế' },
  { field: 'isa22', titleVi: 'Lợi nhuận của Cổ đông của Công ty mẹ' },
  { field: 'isa23', titleVi: 'Lãi cơ bản trên cổ phiếu (VND)' },
];
const F_BANK = [
  { field: 'isb27', titleVi: 'Thu nhập lãi thuần' },
  { field: 'isa20', titleVi: 'Lợi nhuận sau thuế' },
  { field: 'isa22', titleVi: 'Cổ đông của Công ty mẹ' },
];

function routedFetch({ ratios, metrics, statement }) {
  return async (url) => {
    if (url.includes('/statistics-financial')) return { ok: true, json: async () => ({ data: ratios }) };
    if (url.includes('/financial-statement/metrics')) return { ok: true, json: async () => metrics };
    if (url.includes('/financial-statement')) return { ok: true, json: async () => ({ data: { quarters: statement } }) };
    throw new Error(`unexpected url: ${url}`);
  };
}

test('collectFundamentals đính kèm doanh thu (isa3) cho công ty phi tài chính', async () => {
  const fetchImpl = routedFetch({
    ratios: [ratioRow(2026, 2, 11.6)],
    metrics: metricsBody(F_NONBANK),
    statement: [{ yearReport: 2026, lengthReport: 2, isa3: 23_213e9, isa20: 3_233e9, isa22: 2_620e9, isa23: 3903 }],
  });
  const r = await collectFundamentals('HOSE:FPT', fetchImpl);
  assert.equal(r.incomeStatement.revenue.label, 'Doanh thu thuần');
  assert.equal(r.incomeStatement.revenue.value, 23_213e9);
  assert.equal(r.incomeStatement.netProfitParent.value, 2_620e9);
});

test('collectFundamentals dùng thu nhập lãi thuần (isb27) làm doanh thu cho ngân hàng, không lẫn sang isa3', async () => {
  const fetchImpl = routedFetch({
    ratios: [ratioRow(2026, 2, 8.2)],
    metrics: metricsBody(F_BANK),
    statement: [{ yearReport: 2026, lengthReport: 2, isb27: 15_000e9, isa20: 9_000e9, isa22: 8_800e9 }],
  });
  const r = await collectFundamentals('HOSE:VCB', fetchImpl);
  assert.equal(r.incomeStatement.revenue.label, 'Thu nhập lãi thuần');
  assert.equal(r.incomeStatement.revenue.value, 15_000e9);
});

test('collectFundamentals lấy đúng quý MỚI NHẤT của báo cáo thu nhập, không phải phần tử cuối mảng', async () => {
  const fetchImpl = routedFetch({
    ratios: [ratioRow(2026, 2, 11.6)],
    metrics: metricsBody(F_NONBANK),
    statement: [
      { yearReport: 2026, lengthReport: 2, isa3: 100, isa20: 10 },
      { yearReport: 2025, lengthReport: 4, isa3: 999, isa20: 999 },
      { yearReport: 2026, lengthReport: 1, isa3: 50, isa20: 5 },
    ],
  });
  const r = await collectFundamentals('HOSE:FPT', fetchImpl);
  assert.equal(r.incomeStatement.yearReport, 2026);
  assert.equal(r.incomeStatement.quarter, 2);
  assert.equal(r.incomeStatement.revenue.value, 100);
});

test('collectFundamentals vẫn trả về tỷ lệ bình thường khi endpoint doanh thu lỗi — best-effort', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/statistics-financial')) return { ok: true, json: async () => ({ data: [ratioRow(2026, 2, 11.6)] }) };
    return { ok: false, status: 500 };
  };
  const r = await collectFundamentals('HOSE:FPT', fetchImpl);
  assert.equal(r.pe, 11.6);
  assert.equal(r.incomeStatement, null);
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
