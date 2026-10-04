/**
 * Provider DeepSeek. API tương thích OpenAI nên tái dụng luôn adapter đó,
 * chỉ đổi endpoint — không sao chép lại logic dịch.
 */
import { createOpenAiProvider } from './openai.js';

const API_URL = 'https://api.deepseek.com/chat/completions';

export function createDeepSeekProvider({ apiKey, model, fetchImpl = fetch }) {
  const inner = createOpenAiProvider({ apiKey, model, fetchImpl, apiUrl: API_URL });
  return {
    name: 'deepseek', model,
    async complete(args) {
      try {
        return await inner.complete(args);
      } catch (err) {
        // Đổi nhãn lỗi để log không nói nhầm là lỗi OpenAI.
        throw new Error(err.message.replace(/^openai:/, 'deepseek:'));
      }
    },
  };
}
