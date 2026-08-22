import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTestDb, resetTables } from '../../../tests/helpers/db.js';
import {
  createUniverseRepo, createOpsRepo, createIntradayFlowRepo,
} from '@stockagents/db';
import {
  collectBoardSnapshot, collectRecentFlow, collectIntradayFlowBatch,
} from '../src/collectors/intraday_flow.js';
import { runPollIntradayFlow } from '../src/jobs/poll_intraday_flow.js';

const silent = { info() {}, warn() {}, error() {} };

const print = (id, matchType, matchVol) => ({ id, matchType, matchVol, matchPrice: '71700.0' });

function boardRow(ticker, { avgMatchPrice = 71166.7, foreignBuy = 100, foreignSell = 50 } = {}) {
  return {
    listingInfo: { symbol: ticker },
    bidAsk: { bidPrices: [{ price: 71900, volume: 8400 }], askPrices: [{ price: 72000, volume: 43800 }] },
    matchPrice: {
      avgMatchPrice, foreignBuyVolume: foreignBuy, foreignSellVolume: foreignSell,
      foreignBuyValue: foreignBuy * 71000, foreignSellValue: foreignSell * 71000,
    },
  };
}

function fakeRecentFetch(rows) {
  return async () => ({ ok: true, json: async () => rows });
}

/* ---------- collectBoardSnapshot ---------- */

test('collectBoardSnapshot lấy VWAP/order book/khối ngoại cho CẢ universe trong MỘT lần gọi', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    return { ok: true, json: async () => [boardRow('FPT'), boardRow('VCB', { avgMatchPrice: 58490.9, foreignBuy: 200, foreignSell: 300 })] };
  };
  const map = await collectBoardSnapshot(['HOSE:FPT', 'HOSE:VCB'], fetchImpl);
  assert.equal(callCount, 1, 'phải là MỘT lần gọi cho cả universe, không phải mỗi mã một lần');
  assert.equal(map.get('HOSE:FPT').vwapVnd, 71_167);
  assert.equal(map.get('HOSE:VCB').vwapVnd, 58_491);
  assert.deepEqual(map.get('HOSE:FPT').bids, [{ price: 71900, volume: 8400 }]);
  assert.equal(map.get('HOSE:VCB').foreignNet.buyVolume, 200);
});

test('collectBoardSnapshot với mảng rỗng trả về Map rỗng, không gọi API', async () => {
  let called = false;
  const map = await collectBoardSnapshot([], async () => { called = true; });
  assert.equal(map.size, 0);
  assert.equal(called, false);
});

test('collectBoardSnapshot ném lỗi rõ khi HTTP lỗi', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => collectBoardSnapshot(['HOSE:FPT'], fetchImpl), /HTTP 500/);
});

/* ---------- collectRecentFlow ---------- */

test('collectRecentFlow cộng dồn đúng khối lượng mua/bán chủ động theo matchType', async () => {
  const fetchImpl = fakeRecentFetch([
    print(1, 'b', '100'), print(2, 'b', '200'), print(3, 's', '50'), print(4, 'unknown', '999'),
  ]);
  const r = await collectRecentFlow('HOSE:FPT', fetchImpl);
  assert.equal(r.recentBuyVolume, 300);
  assert.equal(r.recentSellVolume, 50);
  assert.equal(r.recentPrintCount, 4);
});

test('collectRecentFlow bóc tiền tố sàn khi gọi API (VCI nhận ticker trần)', async () => {
  let seenBody = null;
  const fetchImpl = async (url, opts) => { seenBody = JSON.parse(opts.body); return { ok: true, json: async () => [print(1, 'b', '100')] }; };
  await collectRecentFlow('HOSE:FPT', fetchImpl);
  assert.equal(seenBody.symbol, 'FPT');
});

test('collectRecentFlow ném lỗi rõ khi HTTP lỗi', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => collectRecentFlow('HOSE:FPT', fetchImpl), /HTTP 500/);
});

test('collectRecentFlow ném lỗi rõ khi không có lệnh khớp nào, không trả về giá trị rác', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [] });
  await assert.rejects(() => collectRecentFlow('HOSE:FPT', fetchImpl), /không có dữ liệu/);
});

/* ---------- collectIntradayFlowBatch ---------- */

test('collectIntradayFlowBatch gộp board + recent flow cho mỗi mã', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('getList')) return { ok: true, json: async () => [boardRow('FPT')] };
    return { ok: true, json: async () => [print(1, 'b', '100')] };
  };
  const { snapshots, errors } = await collectIntradayFlowBatch(['HOSE:FPT'], fetchImpl);
  assert.equal(errors.length, 0);
  assert.equal(snapshots[0].payload.vwapVnd, 71_167);
  assert.equal(snapshots[0].payload.recentBuyVolume, 100);
});

test('collectIntradayFlowBatch board lỗi cả loạt vẫn không chặn recent flow riêng từng mã', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('getList')) return { ok: false, status: 500 };
    return { ok: true, json: async () => [print(1, 'b', '100')] };
  };
  const { snapshots, errors } = await collectIntradayFlowBatch(['HOSE:FPT'], fetchImpl);
  assert.equal(errors.length, 0);
  assert.equal(snapshots[0].payload.vwapVnd, null);
  assert.equal(snapshots[0].payload.recentBuyVolume, 100);
});

test('collectIntradayFlowBatch một mã lỗi recent flow không chặn các mã còn lại', async () => {
  let recentCall = 0;
  const fetchImpl = async (url) => {
    if (url.includes('getList')) return { ok: true, json: async () => [boardRow('FPT'), boardRow('VCB')] };
    recentCall++;
    if (recentCall === 1) return { ok: false, status: 500 };
    return { ok: true, json: async () => [print(1, 'b', '100')] };
  };
  const { snapshots, errors } = await collectIntradayFlowBatch(['HOSE:FPT', 'HOSE:VCB'], fetchImpl);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].symbol, 'HOSE:FPT');
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].symbol, 'HOSE:VCB');
});

/* ---------- runPollIntradayFlow ---------- */

let client, repos;
const TABLES = ['intraday_flow_snapshot', 'ingest_errors', 'market_holidays', 'universe'];
const TRADING_HOUR = new Date('2026-08-21T03:00:00Z'); // 10:00 giờ VN, thứ Sáu — trong phiên.
const OFF_HOUR = new Date('2026-08-21T23:00:00Z'); // ngoài giờ giao dịch.

const fakeFullFetch = () => async (url) => {
  if (url.includes('getList')) return { ok: true, json: async () => [boardRow('FPT'), boardRow('VCB')] };
  return { ok: true, json: async () => [print(1, 'b', '100')] };
};

before(async () => {
  client = await withTestDb();
  repos = {
    universe: createUniverseRepo(client), ops: createOpsRepo(client),
    intradayFlow: createIntradayFlowRepo(client),
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

test('runPollIntradayFlow ghi snapshot cho mọi mã trong giờ giao dịch', async () => {
  const summary = await runPollIntradayFlow({
    repos, symbols: ['HOSE:FPT', 'HOSE:VCB'], logger: silent, now: TRADING_HOUR,
    fetchImpl: fakeFullFetch(),
  });
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 0);

  const map = await repos.intradayFlow.getLatestForSymbols(['HOSE:FPT', 'HOSE:VCB']);
  assert.ok(map.get('HOSE:FPT').vwapVnd > 0);
});

test('runPollIntradayFlow bỏ qua ngoài giờ giao dịch, không gọi API', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => [print(1, 'b', '100')] }; };
  const summary = await runPollIntradayFlow({
    repos, symbols: ['HOSE:FPT'], logger: silent, now: OFF_HOUR, fetchImpl,
  });
  assert.equal(summary.skipped, true);
  assert.equal(called, false);
});

test('runPollIntradayFlow ghi ingest_errors và vẫn hoàn tất khi một mã lỗi recent flow', async () => {
  let recentCall = 0;
  const fetchImpl = async (url) => {
    if (url.includes('getList')) return { ok: true, json: async () => [boardRow('FPT'), boardRow('VCB')] };
    recentCall++;
    if (recentCall === 1) return { ok: false, status: 500 };
    return { ok: true, json: async () => [print(1, 'b', '100')] };
  };
  const summary = await runPollIntradayFlow({
    repos, symbols: ['HOSE:FPT', 'HOSE:VCB'], logger: silent, now: TRADING_HOUR, fetchImpl,
  });
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 1);

  const { rows } = await client.query(`SELECT symbol FROM ingest_errors WHERE job = 'poll_intraday_flow'`);
  assert.equal(rows.length, 1);
});

test('runPollIntradayFlow với danh sách mã rỗng trả về 0/0, không lỗi', async () => {
  const summary = await runPollIntradayFlow({ repos, symbols: [], logger: silent, now: TRADING_HOUR });
  assert.deepEqual(summary, { succeeded: 0, failed: 0 });
});
