import { topK } from './similarity.js';

export const MAX_LESSONS_IN_PROMPT = 10;

/**
 * Lấy bài học liên quan cho agent.
 *
 * Cô lập được cưỡng chế ở tầng repository: listActive bắt buộc có agentId,
 * nên context của agent này không thể chứa bài học của agent khác (spec §3.2).
 *
 * Chưa có embedder thì trả về danh sách xếp theo confidence — vẫn hữu ích,
 * chỉ là không có ngữ nghĩa. Đó là suy giảm êm, không phải hỏng.
 */
export async function retrieveLessons({ repos, agentId, queryVector, k = MAX_LESSONS_IN_PROMPT }) {
  const all = await repos.lessons.listActive(agentId, 200);
  if (all.length === 0) return [];

  if (!Array.isArray(queryVector) || queryVector.length === 0) {
    return all.slice(0, k).map(l => ({ ...l, similarity: null, score: l.confidence }));
  }
  return topK({ queryVector, items: all, k });
}

/** Chuỗi mô tả ngữ cảnh hiện tại, dùng để sinh vector truy vấn. */
export function buildQueryText({ symbol, sector, marketRegime, indicators = {} }) {
  const parts = [symbol, sector, marketRegime].filter(Boolean);
  for (const [key, value] of Object.entries(indicators)) {
    if (key.startsWith('_') || !Number.isFinite(value)) continue;
    parts.push(`${key}=${value}`);
  }
  return parts.join(' ');
}
