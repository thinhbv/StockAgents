import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, respond, applyAction } from '../src/coordinator.js';

/* ---------- buildSnapshot ---------- */

test('buildSnapshot gộp session, leaderboard và chi tiết từng agent', async () => {
  const routes = {
    session: async () => ({ state: 'DATA_READY' }),
    leaderboard: async () => ({ agents: [
      { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', nav: 1_000_000_000, totalReturnPct: 0, dayPnl: 0 },
    ] }),
    events: async () => ({ events: [{ id: 1, type: 'session.state' }] }),
    positions: async ({ params }) => ({ agentId: params.id, positions: [{ symbol: 'HOSE:FPT' }] }),
    decisions: async ({ params }) => ({ agentId: params.id, decisions: [{ symbol: 'HOSE:FPT', action: 'BUY' }] }),
  };

  const snap = await buildSnapshot({ routes });

  assert.equal(snap.session.state, 'DATA_READY');
  assert.equal(snap.agents.length, 1);
  assert.equal(snap.agents[0].id, 'a1');
  assert.equal(snap.agents[0].positions[0].symbol, 'HOSE:FPT');
  assert.equal(snap.agents[0].recentDecisions[0].action, 'BUY');
  assert.equal(snap.recentEvents.length, 1);
});

/* ---------- respond ---------- */

test('respond trả reply và action từ provider', async () => {
  const provider = { async complete() { return { reply: 'FPT đang lãi 3%', action: { type: 'NONE' } }; } };
  const r = await respond({ provider, message: 'FPT sao rồi', snapshot: {} });
  assert.equal(r.reply, 'FPT đang lãi 3%');
  assert.equal(r.action.type, 'NONE');
});

test('respond bóc phần tử đầu nếu provider trả mảng (khớp hình dạng complete() dùng chung cho agent giao dịch)', async () => {
  const provider = { async complete() { return [{ reply: 'ok', action: { type: 'NONE' } }]; } };
  const r = await respond({ provider, message: 'x', snapshot: {} });
  assert.equal(r.reply, 'ok');
});

test('respond mặc định action = NONE nếu provider không trả action', async () => {
  const provider = { async complete() { return { reply: 'ok' }; } };
  const r = await respond({ provider, message: 'x', snapshot: {} });
  assert.equal(r.action.type, 'NONE');
});

test('respond báo lỗi rõ nếu provider trả sai khuôn — thiếu reply', async () => {
  const provider = { async complete() { return { action: { type: 'NONE' } }; } };
  await assert.rejects(() => respond({ provider, message: 'x', snapshot: {} }), /reply/);
});

test('respond gửi lịch sử hội thoại kèm tin nhắn mới cho provider', async () => {
  let seenMessages = null;
  const provider = { async complete({ messages }) { seenMessages = messages; return { reply: 'ok', action: { type: 'NONE' } }; } };
  const history = [{ role: 'user', content: 'câu trước' }, { role: 'assistant', content: 'trả lời trước' }];
  await respond({ provider, message: 'câu mới', history, snapshot: {} });

  assert.equal(seenMessages.length, 3);
  assert.equal(seenMessages[0].content, 'câu trước');
  assert.match(seenMessages[2].content, /câu mới/);
});

/* ---------- applyAction ---------- */

test('applyAction NONE không làm gì, trả null', async () => {
  const r = await applyAction({ routes: {}, action: { type: 'NONE' } });
  assert.equal(r, null);
});

test('applyAction SET_MODEL gọi routes.updateAgentConfig đúng tham số', async () => {
  let seen = null;
  const routes = { updateAgentConfig: async (args) => { seen = args; return { id: 'a1', provider: 'anthropic', model: 'claude-sonnet-5' }; } };
  const r = await applyAction({
    routes, action: { type: 'SET_MODEL', agentId: 'a1', provider: 'anthropic', model: 'claude-sonnet-5' },
  });
  assert.deepEqual(seen.params, { id: 'a1' });
  assert.deepEqual(seen.body, { provider: 'anthropic', model: 'claude-sonnet-5' });
  assert.match(r, /a1/);
  assert.match(r, /claude-sonnet-5/);
});

test('applyAction SET_RISK gọi routes.updateAgentRisk đúng tham số', async () => {
  let seen = null;
  const routes = { updateAgentRisk: async (args) => { seen = args; return { id: 'a1', riskConfig: { maxPositionPctNav: 10 } }; } };
  const r = await applyAction({
    routes, action: { type: 'SET_RISK', agentId: 'a1', maxPositionPctNav: 10 },
  });
  assert.deepEqual(seen.params, { id: 'a1' });
  assert.equal(seen.body.maxPositionPctNav, 10);
  assert.match(r, /a1/);
});

test('applyAction loại action lạ không ném lỗi, trả cảnh báo', async () => {
  const r = await applyAction({ routes: {}, action: { type: 'DELETE_EVERYTHING' } });
  assert.match(r, /không nhận ra/i);
});

test('applyAction khi routes ném lỗi (ví dụ agent không tồn tại) không ném ra ngoài, trả lý do', async () => {
  const routes = { updateAgentConfig: async () => { throw new Error('404: không có agent'); } };
  const r = await applyAction({
    routes, action: { type: 'SET_MODEL', agentId: 'khong-co', provider: 'anthropic', model: 'x' },
  });
  assert.match(r, /không thực hiện được/i);
  assert.match(r, /404/);
});
