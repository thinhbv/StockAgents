import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLeaderboard, createTelegramReporter } from '../src/reporters/telegram.js';

const silent = { info() {}, warn() {}, error() {} };

const agents = [
  { id: 'a1', name: 'Claude Value', nav: 1_050_000_000, totalReturnPct: 5, positionCount: 3 },
  { id: 'a2', name: 'GPT Momentum', nav: 980_000_000, totalReturnPct: -2, positionCount: 1 },
];

test('báo cáo nêu tên agent, NAV và lãi lỗ', () => {
  const text = formatLeaderboard({ tradeDate: '2026-07-29', agents });
  assert.match(text, /2026-07-29/);
  assert.match(text, /Claude Value/);
  assert.match(text, /1\.050\.000\.000/, 'số tiền phải theo định dạng VN');
  assert.match(text, /5%/);
});

test('dùng ký hiệu ▲▼ chứ không chỉ dựa vào dấu số', () => {
  const text = formatLeaderboard({ tradeDate: '2026-07-29', agents });
  assert.match(text, /▲/);
  assert.match(text, /▼/);
});

test('nêu chênh lệch giữa agent dẫn đầu và cuối bảng', () => {
  const text = formatLeaderboard({ tradeDate: '2026-07-29', agents });
  assert.match(text, /Chênh lệch dẫn đầu: 7 điểm %/);
});

test('không agent nào giao dịch thì nói thẳng, không gửi bảng rỗng', () => {
  const text = formatLeaderboard({ tradeDate: '2026-07-29', agents: [] });
  assert.match(text, /Không agent nào giao dịch/);
});

test('agent chưa có NAV hiển thị gạch ngang, không phải NaN', () => {
  const text = formatLeaderboard({
    tradeDate: '2026-07-29',
    agents: [{ id: 'a1', name: 'Mới', nav: null, totalReturnPct: null, positionCount: 0 }],
  });
  assert.equal(/NaN/.test(text), false);
  assert.match(text, /—/);
});

test('thiếu cấu hình thì reporter tắt, không cố gửi', async () => {
  const r = createTelegramReporter({ token: '', chatId: '', logger: silent });
  assert.equal(r.enabled, false);
  assert.deepEqual(await r.send('xin chào'), { sent: false, reason: 'chưa cấu hình' });
});

test('gửi thành công trả sent true và gọi đúng endpoint', async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url, body: JSON.parse(opts.body) };
    return { ok: true, text: async () => '' };
  };
  const r = createTelegramReporter({ token: 'T', chatId: 'C', fetchImpl, logger: silent });

  assert.deepEqual(await r.send('nội dung'), { sent: true });
  assert.match(seen.url, /\/botT\/sendMessage$/);
  assert.equal(seen.body.chat_id, 'C');
  assert.equal(seen.body.text, 'nội dung');
});

test('Telegram chết KHÔNG làm hỏng phiên — chỉ trả sent false', async () => {
  const fetchImpl = async () => { throw new Error('mạng đứt'); };
  const r = createTelegramReporter({ token: 'T', chatId: 'C', fetchImpl, logger: silent });

  const out = await r.send('x');
  assert.equal(out.sent, false);
  assert.match(out.reason, /mạng đứt/);
});

test('API trả lỗi thì báo lại mã HTTP, không im lặng', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'too many' });
  const r = createTelegramReporter({ token: 'T', chatId: 'C', fetchImpl, logger: silent });
  const out = await r.send('x');
  assert.equal(out.sent, false);
  assert.match(out.reason, /429/);
});

test('Markdown lỗi entity thì gửi lại dạng chữ thường, không mất tin nhắn', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (body.parse_mode === 'Markdown') {
      return {
        ok: false, status: 400,
        text: async () => JSON.stringify({
          ok: false, description: "Bad Request: can't parse entities: Can't find end of the entity",
        }),
      };
    }
    return { ok: true, text: async () => '' };
  };
  const r = createTelegramReporter({ token: 'T', chatId: 'C', fetchImpl, logger: silent });

  const out = await r.send('agent_id chưa đóng dấu *');
  assert.deepEqual(out, { sent: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].parse_mode, 'Markdown');
  assert.equal(calls[1].parse_mode, undefined);
});

test('lỗi HTTP khác lỗi parse entity thì KHÔNG gửi lại, báo lỗi luôn', async () => {
  let callCount = 0;
  const fetchImpl = async () => { callCount++; return { ok: false, status: 429, text: async () => 'too many' }; };
  const r = createTelegramReporter({ token: 'T', chatId: 'C', fetchImpl, logger: silent });

  const out = await r.send('x');
  assert.equal(out.sent, false);
  assert.equal(callCount, 1);
});

test('reportDay lấy bảng xếp hạng rồi gửi đi', async () => {
  let sentText = null;
  const fetchImpl = async (url, opts) => {
    sentText = JSON.parse(opts.body).text;
    return { ok: true, text: async () => '' };
  };
  const routes = { leaderboard: async () => ({ agents }) };
  const r = createTelegramReporter({ token: 'T', chatId: 'C', fetchImpl, logger: silent });

  await r.reportDay({ routes, tradeDate: '2026-07-29' });
  assert.match(sentText, /Claude Value/);
});
