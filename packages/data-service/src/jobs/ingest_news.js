import { scoreSentiment, detectSymbol, decodeEntities } from '../news/sentiment.js';

const JOB = 'ingest_news';

/**
 * Thu tin tức từ các nguồn VN và ghi vào news_items.
 *
 * `sources` được truyền vào (dependency injection) để test không phải gọi
 * mạng: mỗi nguồn là một hàm async trả về mảng { title, url, publishedAt }.
 * Ở chạy thật, entry point nối vào tradingview_mcp/news/sources/*.
 */
export async function runIngestNews({ repos, sources, indices, logger = console, embedder }) {
  const startedAt = Date.now();
  const universe = (await repos.universe.listActive()).map(u => u.symbol);

  const items = [];
  const failedSources = [];

  for (const [name, fetchFn] of Object.entries(sources)) {
    try {
      const raw = await fetchFn();
      for (const a of raw) {
        if (!a?.url || !a?.title) continue;

        // Giải mã TRƯỚC khi chấm điểm và dò mã: từ điển cảm xúc tiếng Việt
        // không khớp được gì trên chuỗi còn nguyên thực thể HTML.
        const title = decodeEntities(a.title);
        const summary = a.summary ? decodeEntities(a.summary) : null;
        const symbol = detectSymbol(title, universe);
        items.push({
          symbol,
          source: name,
          url: a.url,
          title,
          summary,
          sentiment: scoreSentiment(`${title} ${summary ?? ''}`),
          publishedAt: a.publishedAt ?? null,
          embedding: embedder ? await embedder(title) : null,
        });
      }
      logger.info(`[ingest_news] ${name}: ${raw.length} tin`);
    } catch (err) {
      // Một nguồn chết không được chặn các nguồn còn lại — cùng nguyên tắc
      // với ingest giá ở Phase 1.
      failedSources.push(name);
      await repos.ops.logIngestError(JOB, null, `${name}: ${err.message}`);
      logger.warn(`[ingest_news] ${name} lỗi: ${err.message}`);
    }
  }

  const saved = await repos.news.upsertMany(items);

  // Chỉ số thị trường đi cùng job này vì cùng nguồn và cùng nhịp. Lỗi ở đây
  // không được làm hỏng phần tin tức đã thu được.
  let indicesSaved = 0;
  if (typeof indices === 'function') {
    try {
      indicesSaved = await repos.market.insertIndexSnapshots(await indices());
    } catch (err) {
      await repos.ops.logIngestError(JOB, null, `indices: ${err.message}`);
      logger.warn(`[ingest_news] chỉ số thị trường lỗi: ${err.message}`);
    }
  }

  const durationMs = Date.now() - startedAt;

  await repos.events.appendEvent({
    type: 'news.ingested',
    payload: {
      job: JOB, fetched: items.length, saved, indicesSaved,
      withSymbol: items.filter(i => i.symbol).length,
      failedSources, durationMs,
    },
  });

  logger.info(
    `[ingest_news] xong: ${saved} tin mới / ${items.length} thu được, ` +
    `${failedSources.length} nguồn lỗi, ${(durationMs / 1000).toFixed(1)}s`);

  return { fetched: items.length, saved, indicesSaved, failedSources, durationMs };
}
