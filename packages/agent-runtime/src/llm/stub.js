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

  return {
    name: 'stub',
    async complete() {
      if (script.length === 0) return structuredClone(fallback);
      const out = script[Math.min(i, script.length - 1)];
      i++;
      return structuredClone(out);
    },
  };
}
