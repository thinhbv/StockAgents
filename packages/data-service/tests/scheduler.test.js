import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEDULES, startScheduler } from '../src/scheduler.js';

const silent = { info() {}, warn() {}, error() {} };

/** Mọi job trong SCHEDULES, mỗi cái là một hàm rỗng. */
const allJobs = () => Object.fromEntries(SCHEDULES.map(s => [s.name, async () => {}]));

function fakeCronLib() {
  const registered = [];
  return {
    registered,
    schedule(expr, fn, opts) {
      registered.push({ expr, fn, opts });
      return { stop() { registered.splice(registered.indexOf(this), 1); } };
    },
  };
}

test('SCHEDULES định nghĩa đủ các job của hệ thống', () => {
  const names = SCHEDULES.map(s => s.name).sort();
  assert.deepEqual(names, [
    'ingest_news', 'ingest_prices', 'poll_quotes', 'prune_events',
    'report_day', 'watch_close',
  ]);
});

test('mỗi job có một biểu thức cron hợp lệ và không trùng tên', () => {
  const names = SCHEDULES.map(s => s.name);
  assert.equal(new Set(names).size, names.length, 'tên job không được trùng');
  for (const s of SCHEDULES) {
    assert.equal(s.cron.trim().split(/\s+/).length, 5, `${s.name}: cron phải có 5 trường`);
  }
});

test('thứ tự trong ngày đúng: lấy giá trước tin, tin trước phiên, báo cáo cuối', () => {
  const minuteOf = (name) => {
    const [m, h] = SCHEDULES.find(s => s.name === name).cron.split(' ');
    return Number(h.split('-')[0].replace('*/5', '9')) * 60 + Number(m.replace('*/5', '0'));
  };
  assert.ok(minuteOf('ingest_prices') < minuteOf('ingest_news'),
    'phải có giá trước khi thu tin');
  assert.ok(minuteOf('ingest_news') < minuteOf('watch_close'),
    'agent phải thấy tin trước khi chốt sổ');
  assert.ok(minuteOf('watch_close') < minuteOf('report_day'),
    'báo cáo phải sau khi phiên đã chốt sổ');
});

test('cron của ingest_prices chạy 08:30 các ngày T2–T6', () => {
  const s = SCHEDULES.find(s => s.name === 'ingest_prices');
  assert.equal(s.cron, '30 8 * * 1-5');
});

test('cron của poll_quotes chạy mỗi 5 phút trong giờ giao dịch', () => {
  const s = SCHEDULES.find(s => s.name === 'poll_quotes');
  assert.equal(s.cron, '*/5 9-14 * * 1-5');
});

test('startScheduler đăng ký mọi job với múi giờ Việt Nam', () => {
  const cronLib = fakeCronLib();
  startScheduler({ jobs: allJobs(), cronLib, logger: silent });

  assert.equal(cronLib.registered.length, SCHEDULES.length);
  for (const r of cronLib.registered) {
    assert.equal(r.opts.timezone, 'Asia/Ho_Chi_Minh');
  }
});

test('job ném lỗi không làm sập scheduler', async () => {
  const cronLib = fakeCronLib();
  startScheduler({
    jobs: { ...allJobs(), ingest_prices: async () => { throw new Error('bùm'); } },
    cronLib, logger: silent,
  });

  const entry = cronLib.registered.find(r => r.expr === '30 8 * * 1-5');
  await assert.doesNotReject(() => entry.fn());
});

test('stop hủy mọi job đã đăng ký', () => {
  const cronLib = fakeCronLib();
  const scheduler = startScheduler({ jobs: allJobs(), cronLib, logger: silent });

  scheduler.stop();
  assert.equal(cronLib.registered.length, 0);
});

test('startScheduler xác thực đủ job TRƯỚC KHI đăng ký bất kỳ job nào (Finding 3)', () => {
  const cronLib = fakeCronLib();
  assert.throws(
    () => startScheduler({
      // thiếu 'prune_events' — nếu việc kiểm tra nằm trong .map(), hai job
      // đầu (ingest_prices, poll_quotes) sẽ bị đăng ký với timer thật trước
      // khi lỗi ném ra, mồ côi không còn handle để stop().
      // thiếu 'prune_events' trong tập job
      jobs: Object.fromEntries(
        Object.entries(allJobs()).filter(([n]) => n !== 'prune_events')),
      cronLib, logger: silent,
    }),
    /prune_events/,
  );
  assert.equal(cronLib.registered.length, 0, 'không job nào được đăng ký khi thiếu một job');
});

test('drain() chờ job đang chạy dở xong trước khi resolve (Finding 2)', async () => {
  const cronLib = fakeCronLib();
  let jobFinished = false;
  let resolveJob;
  const slowJob = () => new Promise((resolve) => { resolveJob = resolve; });

  const scheduler = startScheduler({
    jobs: { ...allJobs(), ingest_prices: async () => { await slowJob(); jobFinished = true; } },
    cronLib, logger: silent,
  });

  const entry = cronLib.registered.find(r => r.expr === '30 8 * * 1-5');
  const firing = entry.fn(); // không await — mô phỏng cron kích hoạt job

  const draining = scheduler.drain().then(() => {
    assert.equal(jobFinished, true, 'drain() phải resolve SAU KHI job xong, không phải trước');
  });

  resolveJob();
  await firing;
  await draining;
});

test('drain() không có job nào đang chạy thì resolve ngay', async () => {
  const cronLib = fakeCronLib();
  const scheduler = startScheduler({ jobs: allJobs(), cronLib, logger: silent });

  await assert.doesNotReject(() => scheduler.drain());
});

test('drain() hết timeout thì vẫn resolve thay vì treo vô thời hạn', async () => {
  const cronLib = fakeCronLib();
  let resolveJob;
  const scheduler = startScheduler({
    jobs: {
      ...allJobs(),
      // "kẹt" cho tới khi ta tự giải phóng
      ingest_prices: () => new Promise((resolve) => { resolveJob = resolve; }),
    },
    cronLib, logger: silent,
  });

  const entry = cronLib.registered.find(r => r.expr === '30 8 * * 1-5');
  const firing = entry.fn(); // không await — mô phỏng job kẹt trong lúc drain() đang chờ

  await assert.doesNotReject(() => scheduler.drain(20));

  // Dọn dẹp: giải phóng job "kẹt" trước khi test kết thúc — nếu không, một
  // promise treo vĩnh viễn sẽ khiến node:test cảnh báo "Promise resolution
  // is still pending but the event loop has already resolved" ở test khác.
  resolveJob();
  await firing;
});
