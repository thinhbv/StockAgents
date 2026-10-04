import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision } from '../src/llm/decision_schema.js';
import { createStubProvider } from '../src/llm/stub.js';
import { createProvider } from '../src/llm/provider.js';
import { createAnthropicProvider } from '../src/llm/anthropic.js';

const good = {
  action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'LIMIT',
  limitPriceVnd: 118500, confidence: 0.72, reason: 'vượt MA20',
  exitPlan: { takeProfitPct: 8, stopLossPct: -4, timeStopDays: 10 },
};

test('validateDecision chấp nhận quyết định hợp lệ', () => {
  const r = validateDecision(good);
  assert.equal(r.ok, true);
  assert.equal(r.value.action, 'BUY');
});

test('validateDecision ép dấu exitPlan — LLM lỡ trả dương/âm lẫn lộn vẫn ra đúng quy ước', () => {
  const r = validateDecision({
    ...good,
    exitPlan: { stopLossPct: 5, takeProfitPct: -8, trailingPct: -6 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.exitPlan.stopLossPct, -5);
  assert.equal(r.value.exitPlan.takeProfitPct, 8);
  assert.equal(r.value.exitPlan.trailingPct, 6);
});

test('validateDecision từ chối hành động lạ', () => {
  const r = validateDecision({ ...good, action: 'YOLO' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /action/);
});

test('validateDecision từ chối confidence ngoài 0..1', () => {
  assert.equal(validateDecision({ ...good, confidence: 5 }).ok, false);
  assert.equal(validateDecision({ ...good, confidence: -0.1 }).ok, false);
});

test('validateDecision bắt buộc phải có confidence — thang điểm chung giữa các agent', () => {
  const { confidence, ...withoutConfidence } = good;
  const r = validateDecision(withoutConfidence);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /confidence/);
});

test('validateDecision bắt buộc có reason không rỗng', () => {
  const r = validateDecision({ ...good, reason: '   ' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /reason/);
});

test('validateDecision từ chối quantity không phải số nguyên dương', () => {
  assert.equal(validateDecision({ ...good, quantity: 0 }).ok, false);
  assert.equal(validateDecision({ ...good, quantity: 10.5 }).ok, false);
});

test('HOLD không cần quantity hay giá', () => {
  const r = validateDecision({ action: 'HOLD', symbol: 'HOSE:FPT', reason: 'chờ', confidence: 0.5 });
  assert.equal(r.ok, true);
});

test('LIMIT bắt buộc có limitPriceVnd', () => {
  const r = validateDecision({ ...good, orderType: 'LIMIT', limitPriceVnd: null });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /limitPriceVnd/);
});

test('validateDecision gom NHIỀU lỗi, không dừng ở lỗi đầu', () => {
  const r = validateDecision({ action: 'YOLO', symbol: '', quantity: -5, reason: '' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 3, `kỳ vọng nhiều lỗi, nhận ${r.errors.length}`);
});

test('stub provider trả kết quả tất định theo kịch bản', async () => {
  const p = createStubProvider({ script: [[good]] });
  const first = await p.complete({ system: 's', messages: [], jsonSchema: {} });
  assert.deepEqual(first.decisions, [good]);
  assert.deepEqual(first.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test('stub provider lặp lại phần tử cuối khi hết kịch bản', async () => {
  const p = createStubProvider({ script: [[good]] });
  await p.complete({ system: 's', messages: [], jsonSchema: {} });
  const second = await p.complete({ system: 's', messages: [], jsonSchema: {} });
  assert.deepEqual(second.decisions, [good]);
});

test('stub provider mặc định trả HOLD khi không có kịch bản', async () => {
  const p = createStubProvider({});
  const r = await p.complete({ system: 's', messages: [], jsonSchema: {} });
  assert.equal(Array.isArray(r.decisions), true);
  assert.equal(r.decisions[0].action, 'HOLD');
});

test('createProvider chọn stub mà không cần API key', () => {
  const p = createProvider({ provider: 'stub' });
  assert.equal(p.name, 'stub');
});

test('createProvider báo lỗi rõ khi thiếu API key của provider thật', () => {
  assert.throws(
    () => createProvider({ provider: 'anthropic', model: 'claude-opus-5', apiKey: '' }),
    /ANTHROPIC_API_KEY/,
  );
});

test('createProvider từ chối provider không biết', () => {
  assert.throws(() => createProvider({ provider: 'magic' }), /magic/);
});

test('anthropic provider rút decisions từ tool_use', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: 'tool_use', input: { decisions: [good] } }],
      usage: { input_tokens: 500, output_tokens: 80 },
    }),
  });
  const p = createAnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl });
  const r = await p.complete({ system: 's', messages: [], jsonSchema: {} });
  assert.deepEqual(r.decisions, [good]);
  assert.deepEqual(r.usage, { inputTokens: 500, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test('anthropic provider báo lỗi rõ khi phản hồi thiếu tool_use', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: 'xin lỗi' }] }),
  });
  const p = createAnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl });
  await assert.rejects(() => p.complete({ system: 's', messages: [], jsonSchema: {} }), /tool_use/);
});

test('anthropic provider ném lỗi kèm mã HTTP khi API trả lỗi', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
  const p = createAnthropicProvider({ apiKey: 'k', model: 'm', fetchImpl });
  await assert.rejects(() => p.complete({ system: 's', messages: [], jsonSchema: {} }), /429/);
});
