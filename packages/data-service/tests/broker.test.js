import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBroker } from '../src/cdp/broker.js';
import { createFakeCore } from '../../../tests/helpers/fake_core.js';

const silent = { info() {}, warn() {}, error() {} };
const noSleep = () => Promise.resolve();

test('withSymbol đổi symbol rồi chạy callback', async () => {
  const core = createFakeCore();
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  const result = await broker.withSymbol('HOSE:FPT', (c) => c.data.getOhlcv({ count: 60 }));

  assert.equal(result.bar_count, 60);
  // getState là phép kiểm tra chart đã chuyển mã — qua API, không cào DOM.
  assert.deepEqual(core.calls, ['setSymbol:HOSE:FPT', 'getState', 'getOhlcv:HOSE:FPT:60']);
});

test('các lời gọi đồng thời bị tuần tự hóa, không đan xen', async () => {
  const core = createFakeCore({ delayMs: 20 });
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  await Promise.all([
    broker.withSymbol('HOSE:AAA', (c) => c.data.getOhlcv({ count: 10 })),
    broker.withSymbol('HOSE:BBB', (c) => c.data.getOhlcv({ count: 10 })),
    broker.withSymbol('HOSE:CCC', (c) => c.data.getOhlcv({ count: 10 })),
  ]);

  assert.deepEqual(core.calls, [
    'setSymbol:HOSE:AAA', 'getState', 'getOhlcv:HOSE:AAA:10',
    'setSymbol:HOSE:BBB', 'getState', 'getOhlcv:HOSE:BBB:10',
    'setSymbol:HOSE:CCC', 'getState', 'getOhlcv:HOSE:CCC:10',
  ]);
});

test('withSymbol thử lại khi lỗi tạm thời rồi thành công', async () => {
  const core = createFakeCore({ failFirst: 2 });
  const broker = createBroker({ core, logger: silent, maxRetries: 3, sleep: noSleep });

  const result = await broker.withSymbol('HOSE:FPT', (c) => c.data.getOhlcv({ count: 60 }));
  assert.equal(result.bar_count, 60);
  assert.equal(core.calls.filter(c => c.startsWith('getOhlcv')).length, 3);
});

test('withSymbol ném BrokerError kèm symbol sau khi hết lượt thử', async () => {
  const core = createFakeCore({ failFirst: 99 });
  const broker = createBroker({ core, logger: silent, maxRetries: 2, sleep: noSleep });

  await assert.rejects(
    broker.withSymbol('HOSE:FPT', (c) => c.data.getOhlcv({ count: 60 })),
    (err) => {
      assert.equal(err.name, 'BrokerError');
      assert.equal(err.symbol, 'HOSE:FPT');
      assert.equal(err.attempts, 2);
      return true;
    },
  );
});

test('một mã lỗi không chặn mã kế tiếp trong hàng đợi', async () => {
  const core = createFakeCore({ failFirst: 99 });
  const broker = createBroker({ core, logger: silent, maxRetries: 1, sleep: noSleep });

  const results = await Promise.allSettled([
    broker.withSymbol('HOSE:BAD', (c) => c.data.getOhlcv({ count: 10 })),
    broker.withSymbol('HOSE:OK', (c) => c.data.getStudyValues()),
  ]);

  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
});

test('ensureConnected trả về true khi CDP khỏe', async () => {
  const core = createFakeCore();
  const broker = createBroker({ core, logger: silent, sleep: noSleep });
  assert.equal(await broker.ensureConnected(), true);
  assert.equal(core.launchCount, 0);
});

test('ensureConnected tự launch một lần khi CDP đứt', async () => {
  const core = createFakeCore({ healthy: false });
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  assert.equal(await broker.ensureConnected(), true);
  assert.equal(core.launchCount, 1);
});

test('ensureConnected trả về false khi launch cũng không cứu được', async () => {
  const core = createFakeCore({ healthy: false });
  core.health.launch = async () => { core.calls.push('launch'); throw new Error('không tìm thấy TradingView'); };

  const broker = createBroker({ core, logger: silent, sleep: noSleep });
  assert.equal(await broker.ensureConnected(), false);
});

test('ensureConnected trả về false khi CDP kết nối nhưng chart API chưa sẵn sàng', async () => {
  // Mirrors health.js: healthCheck() can RESOLVE with api_available: false
  // (e.g. right after launch, while TradingView is still loading its chart)
  // instead of rejecting — ensureConnected must not treat that as connected.
  const core = createFakeCore({ healthy: true, apiAvailable: false });
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  assert.equal(await broker.ensureConnected(), false);
  assert.equal(core.launchCount, 1);
});

test('withSymbol thử lại khi setSymbol trả chart_ready:false rồi cuối cùng ném BrokerError (Finding 2)', async () => {
  // core.chart.setSymbol thật trả {success, symbol, chart_ready} —
  // chart_ready=false khi waitForChartReady() hết giờ (tradingview_mcp/src/core/chart.js:52).
  // Nếu broker bỏ qua trường này, collectPrices/collectIndicators đọc bar của
  // MÃ CŨ dưới tên mã mới — không có gì ném lỗi. Broker phải tự coi
  // chart_ready:false là một lần thử thất bại.
  const core = createFakeCore({ chartReady: false });
  const broker = createBroker({
    core, logger: silent, maxRetries: 3, sleep: noSleep,
    symbolTimeoutMs: 30, symbolPollMs: 5,
  });

  await assert.rejects(
    broker.withSymbol('HOSE:FPT', (c) => c.data.getOhlcv({ count: 60 })),
    (err) => {
      assert.equal(err.name, 'BrokerError');
      assert.equal(err.symbol, 'HOSE:FPT');
      assert.equal(err.attempts, 3);
      return true;
    },
  );

  // Phải thử lại setSymbol đúng maxRetries lần, và KHÔNG BAO GIỜ chạm tới
  // getOhlcv vì chart chưa sẵn sàng để đọc.
  assert.equal(core.calls.filter(c => c.startsWith('setSymbol')).length, 3);
  assert.ok(!core.calls.some(c => c.startsWith('getOhlcv')));
});

test('stats đếm đúng số việc hoàn thành và thất bại', async () => {
  const core = createFakeCore({ failFirst: 99 });
  const broker = createBroker({ core, logger: silent, maxRetries: 1, sleep: noSleep });

  await broker.withSymbol('HOSE:OK', (c) => c.data.getStudyValues());
  await broker.withSymbol('HOSE:BAD', (c) => c.data.getOhlcv({ count: 10 })).catch(() => {});

  const s = broker.stats();
  assert.equal(s.completed, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.queued, 0);
});

test('withSymbol chấp nhận symbol đã được TradingView chuẩn hoá', async () => {
  // TradingView đổi 'HOSE:FPT' thành 'HOSE_DLY:FPT'. So khớp chuỗi nguyên vẹn
  // sẽ không bao giờ đúng — và mọi mã đều bị bỏ qua với chart_ready=false.
  const core = createFakeCore();
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  const r = await broker.withSymbol('HOSE:FPT', (c) => c.data.getOhlcv({ count: 10 }));
  assert.equal(r.bar_count, 10);
});

test('withSymbol vẫn từ chối khi chart chuyển sang MÃ KHÁC', async () => {
  const core = createFakeCore({ symbolNormalizer: () => 'HOSE_DLY:VCB' });
  const broker = createBroker({
    core, logger: silent, sleep: noSleep, maxRetries: 2,
    symbolTimeoutMs: 30, symbolPollMs: 5,
  });

  await assert.rejects(
    broker.withSymbol('HOSE:FPT', (c) => c.data.getOhlcv({ count: 10 })),
    (err) => {
      assert.equal(err.name, 'BrokerError');
      assert.match(err.message, /HOSE:FPT/);
      return true;
    });
});

test('phép kiểm tra sẵn sàng KHÔNG phụ thuộc DOM legend', async () => {
  // Legend hiển thị tên chỉ báo ('RSI') sau khi ensureStudies thêm chỉ báo,
  // nên mọi phép so khớp dựa vào DOM đều hỏng. Phải dùng chart API.
  const core = createFakeCore();
  const broker = createBroker({ core, logger: silent, sleep: noSleep });

  await broker.withSymbol('HOSE:FPT', (c) => c.data.getOhlcv({ count: 10 }));
  assert.ok(core.calls.some(c => c === 'getState'),
    'phải hỏi chart API, không cào DOM');
});
