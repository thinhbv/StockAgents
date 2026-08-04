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
    name: 'gemini',
    async complete({ system, messages, jsonSchema, maxTokens = 2048, temperature = 1 }) {
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
      return parsed.decisions ?? parsed;
    },
  };
}
