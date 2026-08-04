const TZ = 'Asia/Ho_Chi_Minh';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

// Khoảng epoch-GIÂY hợp lệ: 1990-01-01 .. 2100-01-01. Đủ rộng cho mọi lịch sử
// chart thật, nhưng đủ hẹp để một giá trị mili-giây (vd. Date.now()) không
// bao giờ lọt vào — bắt lỗi đơn vị ngay thay vì âm thầm ra ngày sai.
const MIN_EPOCH_SECONDS = 631152000; // 1990-01-01T00:00:00Z
const MAX_EPOCH_SECONDS = 4102444800; // 2100-01-01T00:00:00Z

/** Unix seconds → 'YYYY-MM-DD' theo giờ Việt Nam. */
export function toVnDate(unixSeconds) {
  if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds)) {
    throw new Error(`toVnDate: cần số giây hữu hạn, nhận được: ${unixSeconds}`);
  }
  if (unixSeconds < MIN_EPOCH_SECONDS || unixSeconds > MAX_EPOCH_SECONDS) {
    throw new Error(
      `toVnDate: cần epoch GIÂY (giây kể từ 1970-01-01), nhận được ${unixSeconds} ` +
      `nằm ngoài khoảng hợp lệ [${MIN_EPOCH_SECONDS}, ${MAX_EPOCH_SECONDS}] — ` +
      `có thể bạn đang truyền mili-giây (vd. Date.now()) thay vì giây.`
    );
  }
  // en-CA cho ra định dạng ISO YYYY-MM-DD
  return dateFormatter.format(new Date(unixSeconds * 1000));
}

export function nowVnDate(now = new Date()) {
  return dateFormatter.format(now);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Thứ Hai–thứ Sáu VÀ không phải ngày nghỉ lễ.
 *
 * `holidays` truyền vào từ bảng `market_holidays` — không nhúng cứng lịch lễ
 * vào code vì lịch nghỉ VN do Chính phủ công bố hằng năm và có thể đổi.
 * Cùng chính sách "lỗi thì bung ra ngay" như `toVnDate` ở trên trong cùng
 * module: một chuỗi ngày không hợp lệ ('garbage', v.v.) cho `getUTCDay()` ra
 * NaN, và `NaN >= 1 && NaN <= 5` âm thầm là `false` — "không phải ngày giao
 * dịch" — chứ không phải một lỗi input, dễ bị bỏ sót.
 */
export function isTradingDay(isoDate, holidays = []) {
  if (typeof isoDate !== 'string' || !ISO_DATE_RE.test(isoDate)) {
    throw new Error(`isTradingDay: cần chuỗi 'YYYY-MM-DD', nhận được: ${isoDate}`);
  }
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`isTradingDay: ngày không hợp lệ: ${isoDate}`);
  }
  const day = parsed.getUTCDay();
  if (day === 0 || day === 6) return false;
  return !(holidays instanceof Set ? holidays.has(isoDate) : holidays.includes(isoDate));
}

const hourMinuteFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
});

function vnMinutesSinceMidnight(date) {
  const parts = hourMinuteFormatter.formatToParts(date);
  const hour = Number(parts.find(p => p.type === 'hour').value);
  const minute = Number(parts.find(p => p.type === 'minute').value);
  return hour * 60 + minute;
}

const MORNING_START = 9 * 60 + 20;  // 09:20
const MORNING_END = 11 * 60 + 30;   // 11:30 — cả hai đầu đều inclusive
const AFTERNOON_START = 13 * 60;    // 13:00
const AFTERNOON_END = 14 * 60 + 30; // 14:30 — cả hai đầu đều inclusive

/**
 * Cửa sổ giờ nên poll báo giá: 09:20–11:30 và 13:00–14:30 giờ Việt Nam,
 * chỉ trong ngày giao dịch (spec §5.2, nghỉ trưa 11:30–13:00).
 *
 * Cron của `poll_quotes` cố tình đơn giản (`*​/5 9-14 * * 1-5`, spec §5.2) —
 * nó KHÔNG tự loại giờ nghỉ trưa hay hai đầu ngày. Bộ lọc chính xác nằm ở
 * đây thay vì mã hoá vào biểu thức cron, vì chuỗi cron không unit-test được
 * còn một predicate với bảng test case thì kiểm chứng được.
 */
export function isTradingWindow(date = new Date(), holidays = []) {
  const isoDate = dateFormatter.format(date);
  if (!isTradingDay(isoDate, holidays)) return false;

  const minutes = vnMinutesSinceMidnight(date);
  return (
    (minutes >= MORNING_START && minutes <= MORNING_END) ||
    (minutes >= AFTERNOON_START && minutes <= AFTERNOON_END)
  );
}
