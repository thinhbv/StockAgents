/**
 * Provider tất định. Cho phép toàn bộ Phase 2 chạy và test được mà không
 * cần API key, không cần mạng, và không tốn token.
 *
 * `script` là mảng các phản hồi. Mỗi lần gọi lấy phần tử kế tiếp; hết
 * kịch bản thì lặp lại phần tử cuối (để vòng lặp phiên không bị đói).
 */
export function createStubProvider({ script = [] } = {}) {
  let i = 0;
  const fallback = [{
    action: 'HOLD', symbol: 'HOSE:FPT', quantity: null, orderType: 'MARKET',
    limitPriceVnd: null, confidence: 0.5,
    reason: 'stub provider: không có kịch bản, giữ nguyên',
    exitPlan: {},
  }];

  const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  return {
    name: 'stub', model: 'stub',
    async complete() {
      if (script.length === 0) return { decisions: structuredClone(fallback), usage: zeroUsage };
      const out = script[Math.min(i, script.length - 1)];
      i++;
      return { decisions: structuredClone(out), usage: zeroUsage };
    },
  };
}
