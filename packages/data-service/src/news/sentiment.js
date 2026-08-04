/**
 * Chấm điểm cảm xúc tin tức tiếng Việt bằng từ điển.
 *
 * Vì sao không dùng LLM: tin tức về ba mươi mã mỗi ngày là hàng trăm lời gọi,
 * trong khi thứ hệ thống cần chỉ là một tín hiệu thô đủ để quyết định CÓ ĐÁNH
 * THỨC agent hay không. Agent tự đọc tiêu đề trong context và tự đánh giá.
 * Dùng LLM ở đây là trả tiền để lấy độ chính xác không ai dùng tới.
 */

const NEGATIVE = [
  'giảm sàn', 'bán tháo', 'lao dốc', 'sụt giảm', 'thua lỗ', 'lỗ nặng', 'phá sản',
  'điều tra', 'khởi tố', 'bắt tạm giam', 'vi phạm', 'xử phạt', 'đình chỉ',
  'hủy niêm yết', 'cảnh báo', 'kiểm soát', 'nợ xấu', 'rút vốn', 'thoái vốn',
  'giảm mạnh', 'tiêu cực', 'khó khăn', 'sa thải', 'đóng cửa',
];

const POSITIVE = [
  'tăng trần', 'bứt phá', 'kỷ lục', 'lãi lớn', 'vượt kế hoạch', 'tăng trưởng',
  'trúng thầu', 'ký hợp đồng', 'mở rộng', 'cổ tức', 'chia thưởng',
  'khối ngoại mua ròng', 'tích cực', 'khởi sắc', 'hồi phục', 'tăng mạnh',
];

/**
 * Trả về khoảng -1..1. Đây là tín hiệu thô, không phải phân tích ngôn ngữ:
 * đủ để phân biệt "bị khởi tố" với "trúng thầu", không hơn.
 */
export function scoreSentiment(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const lower = text.toLowerCase();

  let neg = 0, pos = 0;
  for (const w of NEGATIVE) if (lower.includes(w)) neg++;
  for (const w of POSITIVE) if (lower.includes(w)) pos++;
  if (neg === 0 && pos === 0) return 0;

  const raw = (pos - neg) / (pos + neg);
  return Math.round(raw * 1000) / 1000;
}

/**
 * Giải mã thực thể HTML trong tiêu đề tin.
 *
 * Nguồn tin VN trả về `đ&#243;n` thay vì `đón`. Lưu nguyên như vậy thì agent
 * đọc tiếng Việt méo, và từ điển cảm xúc không khớp được từ nào có dấu.
 */
const NAMED = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };

export function decodeEntities(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z]+;/gi, (m) => NAMED[m.toLowerCase()] ?? m)
    .trim();
}

/** Tìm mã trong universe được nhắc tới trong tiêu đề. */
export function detectSymbol(text, universeSymbols) {
  if (typeof text !== 'string') return null;
  const upper = text.toUpperCase();
  for (const symbol of universeSymbols) {
    const ticker = symbol.split(':')[1];
    // Biên từ để 'HPG' không khớp nhầm trong 'CHPGROUP'.
    // Phải là `\\b`: trong template literal, `\b` là ký tự backspace chứ
    // không phải biên từ của regex — và nó khớp không bao giờ đúng.
    if (new RegExp(`\\b${ticker}\\b`).test(upper)) return symbol;
  }
  return null;
}
