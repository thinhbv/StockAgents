/**
 * Tìm kiếm ngữ nghĩa bằng cosine similarity tính ngay trong Node.
 *
 * Vì sao không dùng pgvector: PostgreSQL 18 trên máy chưa cài extension, và
 * ở quy mô vài trăm lesson mỗi agent thì quét tuyến tính nhanh hơn nhiều so
 * với chi phí vận hành thêm một extension. Khi số lesson vượt vài nghìn,
 * đổi sang pgvector chỉ cần thay hàm `topK` — phần còn lại không đổi.
 */

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    throw new Error(
      `cosine: cần hai vector cùng độ dài và khác rỗng, nhận ${a?.length} và ${b?.length}`);
  }
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Xếp hạng theo similarity NHÂN confidence.
 *
 * Chỉ xếp theo độ giống nhau là sai: một bài học rất giống ngữ cảnh nhưng đã
 * được chứng minh là vô dụng (confidence thấp) không nên đứng trên một bài
 * học hơi kém giống nhưng đã cứu nhiều lệnh. Đây là chỗ lesson scorer thực
 * sự tác động lên hành vi agent.
 */
export function topK({ queryVector, items, k = 10, minScore = 0 }) {
  const scored = [];
  for (const it of items) {
    if (!Array.isArray(it.embedding) || it.embedding.length !== queryVector.length) continue;
    const sim = cosine(queryVector, it.embedding);
    const score = sim * (Number.isFinite(it.confidence) ? it.confidence : 0.5);
    if (score >= minScore) scored.push({ ...it, similarity: sim, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
