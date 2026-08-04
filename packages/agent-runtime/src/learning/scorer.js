/**
 * Chấm điểm bài học — cơ chế chống tự đầu độc (spec §8.4).
 *
 * Không có nó, bảng `lessons` phình thành một đống mê tín và ngày càng làm
 * nhiễu prompt. Đây là chế độ hỏng phổ biến nhất của kiến trúc reflection.
 */

export const RETIRE_BELOW = 0.3;
export const MIN_RETRIEVALS_BEFORE_RETIRE = 10;

/**
 * Làm mượt Laplace: một bài học mới truy xuất một lần và trúng không được
 * nhảy lên confidence 1,0. Với (helped=0, retrieved=0) nó cho 0,5 — đúng
 * bằng giá trị mặc định của cột.
 */
export function scoreLesson({ timesHelped, timesRetrieved }) {
  const h = Number.isFinite(timesHelped) ? Math.max(0, timesHelped) : 0;
  const r = Number.isFinite(timesRetrieved) ? Math.max(0, timesRetrieved) : 0;
  if (h > r) throw new Error(`scoreLesson: timesHelped (${h}) không thể lớn hơn timesRetrieved (${r})`);
  return Math.round(((h + 1) / (r + 2)) * 1000) / 1000;
}

export function shouldRetire({ confidence, timesRetrieved }) {
  return confidence < RETIRE_BELOW && timesRetrieved >= MIN_RETRIEVALS_BEFORE_RETIRE;
}

/** Lãi thì tính là bài học đã giúp; hoà hoặc lỗ thì không. */
export function outcomeHelped(pnl) {
  return Number.isFinite(pnl) && pnl > 0;
}
