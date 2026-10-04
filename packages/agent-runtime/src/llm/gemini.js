/**
 * Provider Google Gemini. Dùng responseSchema để ép JSON.
 *
 * Gemini không nhận `system` như một vai riêng trong `contents` — nó có
 * trường `systemInstruction` tách bạch. Gộp nhầm vào contents sẽ khiến
 * persona của agent bị coi như lời người dùng.
 */
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export function createGeminiProvider({ apiKey, model, fetchImpl = fetch, baseUrl = BASE }) {
  return {
    name: 'gemini', model,
    // 4096, không phải 2048 mặc định cũ — xem lý do trong anthropic.js: agent
    // giờ có thể ra 8-10 quyết định/phiên từ khi bỏ trần số vị thế, và JSON
    // dài bị cắt giữa chừng sẽ để lại phần tử rỗng ở cuối mảng `decisions`.
    async complete({ system, messages, jsonSchema, maxTokens = 4096, temperature = 1 }) {
      const res = await fetchImpl(`${baseUrl}/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          generationConfig: {
            maxOutputTokens: maxTokens, temperature,
            responseMimeType: 'application/json',
            responseSchema: jsonSchema,
          },
        }),
      });

      if (!res.ok) throw new Error(`gemini: HTTP ${res.status} — ${await res.text()}`);
      const body = await res.json();
      const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('gemini: phản hồi rỗng — không lấy được JSON');

      const parsed = JSON.parse(text);
      const u = body.usageMetadata ?? {};
      return {
        decisions: parsed.decisions ?? parsed,
        usage: {
          inputTokens: u.promptTokenCount ?? 0,
          outputTokens: u.candidatesTokenCount ?? 0,
          cacheReadTokens: u.cachedContentTokenCount ?? 0,
          cacheWriteTokens: 0,
        },
      };
    },
  };
}
