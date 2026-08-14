import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiProvider } from '../src/llm/openai.js';
import { createGeminiProvider } from '../src/llm/gemini.js';
import { createDeepSeekProvider } from '../src/llm/deepseek.js';
import { createAnthropicProvider } from '../src/llm/anthropic.js';
import { createProvider, availableProviders } from '../src/llm/provider.js';
import { validateDecision } from '../src/llm/decision_schema.js';
import { loadAgentDefs } from '../src/agents/registry.js';

const DECISION = {
  action: 'BUY', symbol: 'HOSE:FPT', quantity: 1000, orderType: 'MARKET',
  limitPriceVnd: null, confidence: 0.7, reason: 'thử nghiệm', exitPlan: {},
};

function capture(responseBody, ok = true, status = 200) {
  const seen = {};
  const fetchImpl = async (url, opts) => {
    seen.url = url;
    seen.body = JSON.parse(opts.body);
    seen.headers = opts.headers;
    return {
      ok, status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    };
  };
  return { seen, fetchImpl };
}

/* ---------- OpenAI ---------- */

test('openai rút decisions từ tool_calls', async () => {
  const { fetchImpl } = capture({
    choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ decisions: [DECISION] }) } }] } }],
  });
  const p = createOpenAiProvider({ apiKey: 'k', model: 'gpt-5', fetchImpl });
  assert.deepEqual(await p.complete({ system: 's', messages: [], jsonSchema: {} }), [DECISION]);
});

test('openai gửi system như một message vai system', async () => {
  const { seen, fetchImpl } = capture({
    choices: [{ message: { tool_calls: [{ function: { arguments: '{"decisions":[]}' } }] } }],
  });
  const p = createOpenAiProvider({ apiKey: 'k', model: 'gpt-5', fetchImpl });
  await p.complete({ system: 'persona đây', messages: [{ role: 'user', content: 'ctx' }], jsonSchema: {} });

  assert.equal(seen.body.messages[0].role, 'system');
  assert.equal(seen.body.messages[0].content, 'persona đây');
  assert.equal(seen.headers.authorization, 'Bearer k');
});

test('openai ép model gọi đúng tool, không để nó tự do trả text', async () => {
  const { seen, fetchImpl } = capture({
    choices: [{ message: { tool_calls: [{ function: { arguments: '{"decisions":[]}' } }] } }],
  });
  const p = createOpenAiProvider({ apiKey: 'k', model: 'gpt-5', fetchImpl });
  await p.complete({ system: 's', messages: [], jsonSchema: { type: 'object' } });

  assert.equal(seen.body.tool_choice.function.name, 'submit_decisions');
});

test('openai báo lỗi rõ khi thiếu tool_calls', async () => {
  const { fetchImpl } = capture({ choices: [{ message: { content: 'xin lỗi' } }] });
  const p = createOpenAiProvider({ apiKey: 'k', model: 'gpt-5', fetchImpl });
  await assert.rejects(() => p.complete({ system: 's', messages: [], jsonSchema: {} }), /tool_calls/);
});

test('openai ném lỗi kèm mã HTTP', async () => {
  const { fetchImpl } = capture({ error: 'rate limited' }, false, 429);
  const p = createOpenAiProvider({ apiKey: 'k', model: 'gpt-5', fetchImpl });
  await assert.rejects(() => p.complete({ system: 's', messages: [], jsonSchema: {} }), /429/);
});

/* ---------- Gemini ---------- */

test('gemini rút decisions từ text đã ép JSON', async () => {
  const { fetchImpl } = capture({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ decisions: [DECISION] }) }] } }],
  });
  const p = createGeminiProvider({ apiKey: 'k', model: 'gemini-2.5-pro', fetchImpl });
  assert.deepEqual(await p.complete({ system: 's', messages: [], jsonSchema: {} }), [DECISION]);
});

test('gemini gửi persona qua systemInstruction, KHÔNG lẫn vào contents', async () => {
  const { seen, fetchImpl } = capture({
    candidates: [{ content: { parts: [{ text: '{"decisions":[]}' }] } }],
  });
  const p = createGeminiProvider({ apiKey: 'k', model: 'gemini-2.5-pro', fetchImpl });
  await p.complete({ system: 'persona đây', messages: [{ role: 'user', content: 'ctx' }], jsonSchema: {} });

  assert.equal(seen.body.systemInstruction.parts[0].text, 'persona đây');
  assert.equal(seen.body.contents.length, 1, 'persona không được thành một lượt trong contents');
  assert.equal(seen.body.contents[0].parts[0].text, 'ctx');
});

test('gemini đổi vai assistant thành model đúng thuật ngữ của nó', async () => {
  const { seen, fetchImpl } = capture({
    candidates: [{ content: { parts: [{ text: '{"decisions":[]}' }] } }],
  });
  const p = createGeminiProvider({ apiKey: 'k', model: 'g', fetchImpl });
  await p.complete({ system: 's', messages: [{ role: 'assistant', content: 'trước đó' }], jsonSchema: {} });
  assert.equal(seen.body.contents[0].role, 'model');
});

test('gemini báo lỗi rõ khi phản hồi rỗng', async () => {
  const { fetchImpl } = capture({ candidates: [] });
  const p = createGeminiProvider({ apiKey: 'k', model: 'g', fetchImpl });
  await assert.rejects(() => p.complete({ system: 's', messages: [], jsonSchema: {} }), /rỗng/);
});

/* ---------- DeepSeek ---------- */

test('deepseek dùng endpoint riêng chứ không gọi sang OpenAI', async () => {
  const { seen, fetchImpl } = capture({
    choices: [{ message: { tool_calls: [{ function: { arguments: '{"decisions":[]}' } }] } }],
  });
  const p = createDeepSeekProvider({ apiKey: 'k', model: 'deepseek-chat', fetchImpl });
  await p.complete({ system: 's', messages: [], jsonSchema: {} });
  assert.match(seen.url, /api\.deepseek\.com/);
});

test('deepseek gắn nhãn lỗi của chính nó, không đổ cho openai', async () => {
  const { fetchImpl } = capture({ error: 'boom' }, false, 500);
  const p = createDeepSeekProvider({ apiKey: 'k', model: 'deepseek-chat', fetchImpl });
  await assert.rejects(
    () => p.complete({ system: 's', messages: [], jsonSchema: {} }),
    (err) => {
      assert.match(err.message, /^deepseek:/);
      assert.equal(/openai/.test(err.message), false);
      return true;
    });
});

/* ---------- Bộ chọn provider ---------- */

test('createProvider dựng được cả bốn nhà cung cấp khi có key', () => {
  for (const [provider, model] of [
    ['anthropic', 'claude-opus-5'], ['openai', 'gpt-5'],
    ['gemini', 'gemini-2.5-pro'], ['deepseek', 'deepseek-chat'],
  ]) {
    const p = createProvider({ provider, model, apiKey: 'k' });
    assert.equal(p.name, provider);
    assert.equal(typeof p.complete, 'function');
  }
});

test('createProvider nêu đúng tên biến môi trường còn thiếu', () => {
  for (const [provider, env] of [
    ['openai', 'OPENAI_API_KEY'], ['gemini', 'GEMINI_API_KEY'],
    ['deepseek', 'DEEPSEEK_API_KEY'], ['anthropic', 'ANTHROPIC_API_KEY'],
  ]) {
    assert.throws(() => createProvider({ provider, model: 'm', apiKey: '' }), new RegExp(env));
  }
});

test('availableProviders chỉ liệt kê nhà cung cấp thực sự có key', () => {
  assert.deepEqual(availableProviders({}), []);
  assert.deepEqual(
    availableProviders({ OPENAI_API_KEY: 'x', GEMINI_API_KEY: '   ' }),
    ['openai'], 'key rỗng hoặc toàn khoảng trắng không tính là có');
});

/* ---------- Năm agent ---------- */

test('config có đủ năm agent, id không trùng', async () => {
  const defs = await loadAgentDefs();
  assert.equal(defs.length, 5);
  assert.equal(new Set(defs.map(d => d.id)).size, 5);
});

// Cố ý CHUNG một persona "nhà đầu tư chuyên nghiệp tự lý luận", không gán
// sẵn trường phái (giá trị/xu hướng/tin tức/định lượng/ngược dòng) hay ngưỡng
// số cứng (% cắt lỗ, RSI...). Khác biệt hành vi giữa 5 agent giờ chỉ còn đến
// từ MODEL đứng sau (provider/model), không phải từ kịch bản chiến lược viết
// sẵn — quyết định thiết kế có chủ đích, không phải thiếu sót.
test('mọi agent chia sẻ cùng một persona "tự lý luận", đủ chi tiết để định hình hành vi', async () => {
  const defs = await loadAgentDefs();
  const personas = defs.map(d => d.personaPrompt);
  assert.equal(new Set(personas).size, 1,
    'persona phải giống hệt nhau — khác biệt agent đến từ model, không phải kịch bản chiến lược viết sẵn');
  for (const d of defs) {
    assert.ok(d.personaPrompt.length > 200, `${d.id}: persona quá ngắn để định hình hành vi`);
    assert.match(d.personaPrompt, /VND/, `${d.id}: persona phải nói rõ đơn vị giá`);
  }
});

test('mọi agent khởi điểm cùng vốn — so sánh mới công bằng', async () => {
  const defs = await loadAgentDefs();
  assert.equal(new Set(defs.map(d => d.initialCapital)).size, 1);
});

test('provider trong config đều là provider dựng được', async () => {
  const defs = await loadAgentDefs();
  for (const d of defs) {
    const p = createProvider({ provider: d.provider, model: d.model, apiKey: 'k' });
    assert.equal(p.name, d.provider);
  }
});

test('đầu ra của mọi provider đều qua được validateDecision', async () => {
  const bodies = {
    openai: { choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ decisions: [DECISION] }) } }] } }] },
    gemini: { candidates: [{ content: { parts: [{ text: JSON.stringify({ decisions: [DECISION] }) }] } }] },
    anthropic: { content: [{ type: 'tool_use', input: { decisions: [DECISION] } }] },
  };
  const makers = {
    openai: createOpenAiProvider, gemini: createGeminiProvider, anthropic: createAnthropicProvider,
  };

  for (const [name, body] of Object.entries(bodies)) {
    const { fetchImpl } = capture(body);
    const p = makers[name]({ apiKey: 'k', model: 'm', fetchImpl });
    const out = await p.complete({ system: 's', messages: [], jsonSchema: {} });
    const v = validateDecision(out[0]);
    assert.equal(v.ok, true, `${name}: đầu ra không qua được schema — ${v.errors?.join('; ')}`);
  }
});
