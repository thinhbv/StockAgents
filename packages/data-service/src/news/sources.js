/**
 * Nối 7 nguồn tin tiếng Việt sẵn có trong `tradingview_mcp/news/sources/`.
 *
 * Đây là file DUY NHẤT trong data-service biết tới các module đó — cùng
 * nguyên tắc với CDP broker: một điểm chạm, mọi thứ khác nhận dữ liệu qua
 * tham số. `runIngestNews` nhận `sources` để test không phải gọi mạng.
 */

const BASE = new URL('../../../../tradingview_mcp/news/sources/', import.meta.url);

const MODULES = {
  cafef: 'cafef.js',
  vnexpress: 'vnexpress.js',
  vietstock: 'vietstock.js',
  vneconomy: 'vneconomy.js',
  vietnambiz: 'vietnambiz.js',
  tinnhanh: 'tinnhanh.js',
};

/**
 * Trả về `{ tên: async () => article[] }` đúng hình dạng runIngestNews cần.
 *
 * Nguồn nào không nạp được module thì BỎ QUA thay vì làm hỏng cả tập —
 * `tradingview_mcp` là repo riêng và có thể đổi mà không báo trước.
 */
export async function loadNewsSources({ limit = 12, logger = console } = {}) {
  const sources = {};

  for (const [name, file] of Object.entries(MODULES)) {
    try {
      const mod = await import(new URL(file, BASE).href);
      if (typeof mod.fetch !== 'function') {
        logger.warn(`[news] ${name}: module không có hàm fetch, bỏ qua`);
        continue;
      }
      sources[name] = () => mod.fetch(limit);
    } catch (err) {
      logger.warn(`[news] ${name}: không nạp được module — ${err.message}`);
    }
  }

  if (Object.keys(sources).length === 0) {
    throw new Error(
      'loadNewsSources: không nạp được nguồn tin nào. Kiểm tra thư mục ' +
      'tradingview_mcp/news/sources/ còn tồn tại không.');
  }
  return sources;
}

/** Chỉ số thị trường từ SSI iBoard, đưa về hình dạng market_index_snapshot. */
export async function loadMarketIndices({ logger = console } = {}) {
  try {
    const mod = await import(new URL('market_indices.js', BASE).href);
    const indices = await mod.fetchAllIndices();
    // Hình dạng thật đã kiểm chứng từ SSI iBoard:
    // { id: 'VNINDEX', name, value: 1744.66, change, changePct: 2.35, ... }
    return (indices ?? [])
      .filter(i => i && i.id && Number.isFinite(Number(i.value)))
      .map(i => ({
        indexCode: i.id,
        value: Number(i.value),
        changePct: Number.isFinite(Number(i.changePct)) ? Number(i.changePct) : null,
      }));
  } catch (err) {
    logger.warn(`[news] không lấy được chỉ số thị trường: ${err.message}`);
    return [];
  }
}
