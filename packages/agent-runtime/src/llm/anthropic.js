/**
 * Provider Claude. Dùng tool-use để ép structured output — đó là cách
 * đáng tin nhất để nhận JSON đúng schema từ Claude.
 *
 * Gọi HTTP trực tiếp, không thêm SDK: chỉ một endpoint, và thêm dependency
 * cho một lời gọi fetch là không đáng.
 */
const API_URL = 'https://api.anthropic.com/v1/messages';

export function createAnthropicProvider({ apiKey, model, fetchImpl = fetch }) {
  return {
    name: 'anthropic', model,
    // 2048 từng đủ khi agent chỉ mua 1-2 mã mỗi phiên; từ khi bỏ trần số vị
    // thế/số mã mới (agent tự do dàn trải), một phiên có thể ra 8-10 quyết
    // định cùng lúc — đã thấy thật: tool_use bị cắt giữa chừng, phần tử cuối
    // trong `decisions` rỗng toàn bộ field vì JSON chưa kịp ghi xong.
    async complete({ system, messages, jsonSchema, maxTokens = 4096, temperature = 1 }) {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model, max_tokens: maxTokens, temperature, system, messages,
          tools: [{
            name: 'submit_decisions',
            description: 'Nộp danh sách quyết định giao dịch',
            input_schema: jsonSchema,
          }],
          tool_choice: { type: 'tool', name: 'submit_decisions' },
        }),
      });

      if (!res.ok) {
        throw new Error(`anthropic: HTTP ${res.status} — ${await res.text()}`);
      }
      const body = await res.json();
      const toolUse = body.content?.find(c => c.type === 'tool_use');
      if (!toolUse) {
        throw new Error('anthropic: phản hồi không chứa tool_use — không lấy được JSON');
      }
      const u = body.usage ?? {};
      return {
        decisions: toolUse.input.decisions ?? toolUse.input,
        usage: {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
