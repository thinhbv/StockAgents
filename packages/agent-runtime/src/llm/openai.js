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
    name: 'openai',
    async complete({ system, messages, jsonSchema, maxTokens = 2048, temperature = 1 }) {
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
      return args.decisions ?? args;
    },
  };
}
