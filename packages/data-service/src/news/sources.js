/**
 * Nối 9 nguồn tin tiếng Việt sẵn có trong `tradingview_mcp/news/sources/`.
 *
 * Đây là file DUY NHẤT trong data-service biết tới các module đó — cùng
 * nguyên tắc với CDP broker: một điểm chạm, mọi thứ khác nhận dữ liệu qua
 * tham số. `runIngestNews` nhận `sources` để test không phải gọi mạng.
 */

import { decodeEntities } from './sentiment.js';

const BASE = new URL('../../../../tradingview_mcp/news/sources/', import.meta.url);

const MODULES = {
  cafef: 'cafef.js',
  vnexpress: 'vnexpress.js',
  vietstock: 'vietstock.js',
  vneconomy: 'vneconomy.js',
  vietnambiz: 'vietnambiz.js',
  tinnhanh: 'tinnhanh.js',
  vietnamplus: 'vietnamplus.js',
  tbtcvn: 'thoibaotaichinhvietnam.js',
  hmoney24: '24hmoney.js',
};

// Các module nguồn chỉ lấy tiêu đề và link từ trang chủ, không có ngày đăng.
// Ngày nằm trong metadata của chính trang bài viết nên đọc từ đó.
const PUBLISHED_META = [
  /<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|og:published_time|pubdate|publishdate|publish_date|dc\.date(?:\.issued)?|datePublished)["'][^>]*content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["'](?:article:published_time|og:published_time|pubdate|publishdate|publish_date|dc\.date(?:\.issued)?|datePublished)["']/i,
  /<time[^>]+datetime=["']([^"']+)["']/i,
];

const PAGE_CONCURRENCY = 4;

/**
 * Ngày đăng (ISO) đọc từ HTML của một bài. Chuỗi không có múi giờ được hiểu là
 * giờ Việt Nam. Không đọc được thì trả null, không đoán: bài đó sẽ không lọt
 * vào các cửa sổ thời gian thay vì bị coi là tin mới.
 */
export function parsePublishedAt(html) {
  for (const re of PUBLISHED_META) {
    const m = html.match(re);
    if (!m) continue;
    const s = decodeEntities(m[1])                          // &#x2B;07:00 → +07:00 (vneconomy)
      .replace(/([+-]\d{2})(\d{2})$/, '$1:$2')              // +0700 → +07:00
      .replace(/^(\d{4}-\d{2}-\d{2}T[\d:.]+)$/, '$1+07:00'); // không có múi giờ
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/** Tải từng trang bài để lấy ngày đăng. Bài nào không tải được vẫn được giữ, chỉ thiếu ngày. */
async function withPublishedAt(items, fetchHtml) {
  const out = [];
  for (let i = 0; i < items.length; i += PAGE_CONCURRENCY) {
    const batch = items.slice(i, i + PAGE_CONCURRENCY);
    const dated = await Promise.all(batch.map(async (item) => {
      if (item.publishedAt) return item;
      let publishedAt = null;
      try {
        publishedAt = parsePublishedAt(await fetchHtml(item.url));
      } catch {
        // Không tải được trang: để null.
      }
      return { ...item, publishedAt };
    }));
    out.push(...dated);
  }
  return out;
}

/**
 * Trả về `{ tên: async () => article[] }` đúng hình dạng runIngestNews cần.
 *
 * Nguồn nào không nạp được module thì BỎ QUA thay vì làm hỏng cả tập —
 * `tradingview_mcp` là repo riêng và có thể đổi mà không báo trước.
 */
export async function loadNewsSources({ limit = 12, logger = console } = {}) {
  const { fetchHtml } = await import(new URL('_fetch.js', BASE).href);
  const sources = {};

  for (const [name, file] of Object.entries(MODULES)) {
    try {
      const mod = await import(new URL(file, BASE).href);
      if (typeof mod.fetch !== 'function') {
        logger.warn(`[news] ${name}: module không có hàm fetch, bỏ qua`);
        continue;
      }
      sources[name] = async () => withPublishedAt(await mod.fetch(limit), fetchHtml);
    } catch (err) {
      logger.warn(`[news] ${name}: không nạp được module — ${err.message}`);
    }
  }

  if (Object.keys(sources).length === 0) {
    throw new Error(
      'loadNewsSources: không nạp được nguồn tin nào. Kiểm tra thư mục ' +
      'tradingview-mcp/news/sources/ còn tồn tại không.');
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
