import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramPoll } from '../src/telegram_poll.js';

const silent = { info() {}, warn() {}, error() {} };

function fakeFetch(responses) {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: true, json: async () => ({ ok: true, result: r }) };
  };
}

test('pollOnce chỉ gọi onMessage cho tin từ đúng chat đã cấu hình', async () => {
  const seen = [];
  const fetchImpl = fakeFetch([[
    { update_id: 1, message: { chat: { id: 999 }, text: 'lạ' } },
    { update_id: 2, message: { chat: { id: 42 }, text: 'đúng' } },
  ]]);
  const poll = createTelegramPoll({
    token: 't', allowedChatId: 42, fetchImpl, logger: silent,
    onMessage: async (text) => { seen.push(text); },
  });

  await poll.pollOnce();
  assert.deepEqual(seen, ['đúng'], 'chỉ tin từ chat 42 được xử lý');
});

test('pollOnce đẩy offset qua update_id lớn nhất + 1', async () => {
  const fetchImpl = fakeFetch([[
    { update_id: 5, message: { chat: { id: 42 }, text: 'a' } },
    { update_id: 7, message: { chat: { id: 42 }, text: 'b' } },
  ]]);
  const poll = createTelegramPoll({
    token: 't', allowedChatId: 42, fetchImpl, logger: silent, onMessage: async () => {},
  });
  await poll.pollOnce();
  assert.equal(poll.getOffset(), 8);
});

test('pollOnce bỏ qua update không có text (ví dụ ảnh, sticker)', async () => {
  const seen = [];
  const fetchImpl = fakeFetch([[
    { update_id: 1, message: { chat: { id: 42 }, sticker: {} } },
    { update_id: 2, message: { chat: { id: 42 }, text: 'chào' } },
  ]]);
  const poll = createTelegramPoll({
    token: 't', allowedChatId: 42, fetchImpl, logger: silent,
    onMessage: async (text) => { seen.push(text); },
  });
  await poll.pollOnce();
  assert.deepEqual(seen, ['chào']);
});

test('lỗi trong onMessage của một tin không chặn các tin còn lại trong cùng batch', async () => {
  const seen = [];
  const fetchImpl = fakeFetch([[
    { update_id: 1, message: { chat: { id: 42 }, text: 'lỗi' } },
    { update_id: 2, message: { chat: { id: 42 }, text: 'ổn' } },
  ]]);
  const poll = createTelegramPoll({
    token: 't', allowedChatId: 42, fetchImpl, logger: silent,
    onMessage: async (text) => {
      if (text === 'lỗi') throw new Error('bùm');
      seen.push(text);
    },
  });
  await poll.pollOnce();
  assert.deepEqual(seen, ['ổn']);
});

test('getUpdates trả HTTP lỗi thì pollOnce ném lỗi rõ, không nuốt im lặng', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const poll = createTelegramPoll({ token: 't', allowedChatId: 42, fetchImpl, logger: silent, onMessage: async () => {} });
  await assert.rejects(() => poll.pollOnce(), /500/);
});

test('so sánh allowedChatId dạng số với chat id dạng string trong payload vẫn khớp', async () => {
  const seen = [];
  const fetchImpl = fakeFetch([[{ update_id: 1, message: { chat: { id: '42' }, text: 'ok' } }]]);
  const poll = createTelegramPoll({
    token: 't', allowedChatId: 42, fetchImpl, logger: silent,
    onMessage: async (text) => { seen.push(text); },
  });
  await poll.pollOnce();
  assert.deepEqual(seen, ['ok']);
});
