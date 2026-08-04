import { createStubProvider } from './stub.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAiProvider } from './openai.js';
import { createGeminiProvider } from './gemini.js';
import { createDeepSeekProvider } from './deepseek.js';

const ENV_KEY = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

const FACTORY = {
  anthropic: createAnthropicProvider,
  openai: createOpenAiProvider,
  gemini: createGeminiProvider,
  deepseek: createDeepSeekProvider,
};

export function createProvider({ provider, model, apiKey, script, fetchImpl }) {
  if (provider === 'stub') return createStubProvider({ script });

  const envName = ENV_KEY[provider];
  if (!envName) {
    throw new Error(
      `createProvider: không biết provider '${provider}'. ` +
      `Hỗ trợ: stub, ${Object.keys(ENV_KEY).join(', ')}.`);
  }

  const key = apiKey ?? process.env[envName];
  if (!key || String(key).trim() === '') {
    throw new Error(
      `createProvider: thiếu ${envName} cho provider '${provider}'. ` +
      `Điền vào .env, hoặc dùng provider 'stub' để chạy không cần API key.`);
  }

  return FACTORY[provider]({ apiKey: key, model, ...(fetchImpl ? { fetchImpl } : {}) });
}

/** Provider nào đã có key trong môi trường — dùng để báo cáo, không để chọn thay. */
export function availableProviders(env = process.env) {
  return Object.entries(ENV_KEY)
    .filter(([, name]) => (env[name] ?? '').trim() !== '')
    .map(([p]) => p);
}
