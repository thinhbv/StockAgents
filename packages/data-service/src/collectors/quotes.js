/**
 * Poll giá cho một danh sách mã.
 * Một mã lỗi KHÔNG được làm hỏng cả batch — trả riêng mảng errors
 * để job gọi quyết định ghi log thế nào.
 */
export async function collectQuotes(broker, symbols) {
  const ticks = [];
  const errors = [];

  for (const symbol of symbols) {
    try {
      const q = await broker.withSymbol(symbol, (core) => core.data.getQuote({ symbol }));
      // getQuote trả lại `symbol` nó THỰC SỰ đọc được (data.js:255,277). Nếu
      // chart chưa chuyển xong (hoặc lệch symbol vì lý do khác), giá trị đọc
      // được là của mã CŨ nhưng không có lỗi nào bung ra — phải tự đối chiếu.
      if (q.symbol !== symbol) {
        throw new Error(`collectQuotes: ${symbol} nhận nhầm dữ liệu của mã ${q.symbol}`);
      }
      // core.data.getQuote KHÔNG trả trường `price`. Nó trả `last` và `close`
      // (cùng lấy từ bar cuối) và tự ném lỗi nếu thiếu cả hai — xem
      // tradingview_mcp/src/core/data.js. Đọc nhầm tên trường sẽ cho NaN
      // mà không có lỗi nào bung ra.
      const price = q.last ?? q.close;
      if (!Number.isFinite(Number(price))) {
        throw new Error(`collectQuotes: ${symbol} trả về giá không hợp lệ: ${price}`);
      }
      ticks.push({
        symbol,
        price: Number(price),
        volume: q.volume === undefined ? null : Number(q.volume),
      });
    } catch (err) {
      errors.push({ symbol, message: err.message });
    }
  }

  return { ticks, errors };
}
