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

  // ponytail: nhiều mã VN30 khác nhau ra CÙNG một giá trong một lượt poll là
  // gần như không thể thật — đã thấy thật ngoài đời (12 mã cùng ra 22.200đ
  // một lúc, ts=2026-08-14T06:00:26Z): waitForSymbol/so khớp q.symbol đều qua,
  // nhưng panel giá của CDP chưa kịp refresh nên trả giá của lượt đọc trước.
  // Ngưỡng ≥2 mã trùng giá là đủ nghi ngờ để không tin — nếu sau này có coincidence
  // thật (hai mã giá tham chiếu giống hệt nhau), nâng ngưỡng lên thay vì bỏ hẳn.
  const byPrice = new Map();
  for (const t of ticks) {
    if (!byPrice.has(t.price)) byPrice.set(t.price, []);
    byPrice.get(t.price).push(t);
  }
  const clean = [];
  for (const group of byPrice.values()) {
    if (group.length >= 2) {
      for (const t of group) {
        errors.push({
          symbol: t.symbol,
          message: `collectQuotes: giá ${t.price} trùng với ${group.length - 1} mã khác cùng lượt poll — nghi CDP chưa refresh, bỏ qua`,
        });
      }
    } else {
      clean.push(...group);
    }
  }

  return { ticks: clean, errors };
}
