/**
 * Provider OpenAI. Dùng function-calling để ép structured output.
 *
 * Ba nhà cung cấp OpenAI/Gemini/DeepSeek đều nhận JSON Schema nhưng bọc nó
 * theo khuôn riêng, và trả kết quả ở chỗ khác nhau. Mỗi file lo đúng phần
 * dịch của mình; bên gọi chỉ thấy một interface `complete()`.
 */
const API_URL = 'https://api.openai.com/v1/chat/completions';

export function createOpenAiProvider({ apiKey, model, fetchImpl = fetch, apiUrl = API_URL }) {
  return {
    name: 'openai', model,
    // 4096, không phải 2048 mặc định cũ — xem lý do trong anthropic.js: agent
    // giờ có thể ra 8-10 quyết định/phiên từ khi bỏ trần số vị thế, và JSON
    // dài bị cắt giữa chừng sẽ để lại phần tử rỗng ở cuối mảng `decisions`.
    async complete({ system, messages, jsonSchema, maxTokens = 4096, temperature = 1 }) {
      const res = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, max_completion_tokens: maxTokens, temperature,
          messages: [{ role: 'system', content: system }, ...messages],
          tools: [{
            type: 'function',
            function: { name: 'submit_decisions', parameters: jsonSchema },
          }],
          tool_choice: { type: 'function', function: { name: 'submit_decisions' } },
        }),
      });

      if (!res.ok) throw new Error(`openai: HTTP ${res.status} — ${await res.text()}`);
      const body = await res.json();
      const call = body.choices?.[0]?.message?.tool_calls?.[0];
      if (!call) throw new Error('openai: phản hồi không chứa tool_calls — không lấy được JSON');

      const args = JSON.parse(call.function.arguments);
      const u = body.usage ?? {};
      return {
        decisions: args.decisions ?? args,
        usage: {
          inputTokens: u.prompt_tokens ?? 0,
          outputTokens: u.completion_tokens ?? 0,
          // OpenAI/DeepSeek tự cache tiền tố lặp lại (prompt >1024 token),
          // không cần cache_control — số đọc-từ-cache nằm trong
          // prompt_tokens_details, DeepSeek dùng tên field riêng.
          cacheReadTokens: u.prompt_tokens_details?.cached_tokens
            ?? u.prompt_cache_hit_tokens ?? 0,
          cacheWriteTokens: 0,
        },
      };
    },
  };
}
