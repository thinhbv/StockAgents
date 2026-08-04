/**
 * TradingView yêu cầu TÊN ĐẦY ĐỦ khi thêm chỉ báo
 * ("Relative Strength Index", không phải "RSI") — xem tradingview_mcp/CLAUDE.md.
 */
/**
 * Mỗi mục là { name, inputs? }. `manageIndicator({action:'add', ...})` không
 * truyền `inputs` sẽ tạo study ở chu kỳ MẶC ĐỊNH của TradingView — với
 * "Moving Average Simple" đó là 9, KHÔNG PHẢI 20 như khóa `ma20` ngụ ý, nên
 * phải truyền tường minh `{ length: 20 }` (chart.js:92 hỗ trợ tham số này).
 * Bốn chỉ báo còn lại ĐÃ được kiểm tra: RSI (14), MACD (12/26/9),
 * Bollinger Bands (20/2), Average True Range (14) — mặc định của TradingView
 * khớp với những gì spec cần, nên không truyền `inputs` cho chúng. Đây là một
 * lựa chọn đã kiểm chứng, không phải một giả định bỏ ngỏ.
 */
export const REQUIRED_STUDIES = [
  { name: 'Relative Strength Index' },
  { name: 'Moving Average Simple', inputs: { length: 20 } },
  { name: 'MACD' },
  { name: 'Bollinger Bands' },
  { name: 'Average True Range' },
];

/**
 * Đảm bảo mọi chỉ báo bắt buộc đang có trên chart.
 * Chart là trạng thái toàn cục nên chỉ cần chạy một lần mỗi lần khởi động
 * data-service, không phải mỗi mã.
 *
 * Chỉ có MỘT đường MA ở Phase 1. `getStudyValues` trả về các instance cùng
 * tên là các mục trùng `name`, không phân biệt được chu kỳ (MA50 vs MA200).
 * Muốn phân biệt, Phase 2 cần đọc id của từng study qua `chart.getState()` —
 * response đó trả về `{ id, name }` cho mỗi study (tradingview_mcp/src/core/chart.js:26),
 * KHÔNG có trường `entity_id`. `entity_id` chỉ xuất hiện trong kết quả của
 * `manageIndicator({action:'add', ...})` (chart.js:103), một API khác. Đọc
 * nhầm trường ở đây sẽ cho `undefined` mà không báo lỗi gì.
 */
export async function ensureStudies(broker) {
  return broker.run(async (core) => {
    const state = await core.chart.getState();
    const present = new Set((state.studies || []).map(s => s.name));

    const added = [];
    for (const { name, inputs } of REQUIRED_STUDIES) {
      if (present.has(name)) continue;
      const params = { action: 'add', indicator: name };
      if (inputs) params.inputs = inputs;
      await core.chart.manageIndicator(params);
      added.push(name);
    }
    return added;
  });
}
