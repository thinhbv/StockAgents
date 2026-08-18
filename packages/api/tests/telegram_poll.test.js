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

test('có botId/botUsername: bỏ qua tin nhóm không @mention và không reply bot', async () => {
  const seen = [];
  const fetchImpl = fakeFetch([[
    { update_id: 1, message: { chat: { id: 42 }, text: 'chào mọi người' } },
  ]]);
  const poll = createTelegramPoll({
    token: 't', allowedChatId: 42, fetchImpl, logger: silent,
    botId: 999, botUsername: 'my_bot',
    onMessage: async (text) => { seen.push(text); },
  });
  await poll.pollOnce();
  assert.deepEqual(seen, [], 'tin không nhắc tới bot phải bị bỏ qua');
});

test('có botId/botUsername: xử lý tin có @mention đúng username bot', async () => {
  const seen = [];
  const text = '@my_bot giá FPT bao nhiêu';
  const fetchImpl = fakeFetch([[{
    update_id: 1,
    message: {
      chat: { id: 42 }, text,
      entities: [{ type: 'mention', offset: 0, length: '@my_bot'.length }],
    },
  }]]);
  const poll = createTelegramPoll({
    token: 't', allowedChatId: 42, fetchImpl, logger: silent,
    botId: 999, botUsername: 'my_bot',
    onMessage: async (t) => { seen.push(t); },
  });
  await poll.pollOnce();
  assert.deepEqual(seen, [text]);
});

test('có botId/botUsername: xử lý tin reply trực tiếp vào tin của bot', async () => {
  const seen = [];
  const fetchImpl = fakeFetch([[{
    update_id: 1,
    message: {
      chat: { id: 42 }, text: 'còn lệnh nào không',
      reply_to_message: { from: { id: 999 } },
    },
  }]]);
  const poll = createTelegramPoll({
    token: 't', allowedChatId: 42, fetchImpl, logger: silent,
    botId: 999, botUsername: 'my_bot',
    onMessage: async (t) => { seen.push(t); },
  });
  await poll.pollOnce();
  assert.deepEqual(seen, ['còn lệnh nào không']);
});

test('không truyền botId/botUsername: không lọc mention, giữ hành vi cũ', async () => {
  const seen = [];
  const fetchImpl = fakeFetch([[
    { update_id: 1, message: { chat: { id: 42 }, text: 'chào' } },
  ]]);
  const poll = createTelegramPoll({
    token: 't', allowedChatId: 42, fetchImpl, logger: silent,
    onMessage: async (text) => { seen.push(text); },
  });
  await poll.pollOnce();
  assert.deepEqual(seen, ['chào']);
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
