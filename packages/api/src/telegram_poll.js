/**
 * Long-polling Telegram (getUpdates) — không dùng webhook.
 *
 * Webhook cần Telegram gọi NGƯỢC vào một địa chỉ HTTPS công khai cố định
 * của máy mình; máy chạy hệ thống này không có địa chỉ như vậy. Polling chỉ
 * cần máy này tự gọi RA ngoài, không cần mở cổng, không cần domain/TLS.
 */
const API = 'https://api.telegram.org';

export function createTelegramPoll({
  token, allowedChatId, onMessage, fetchImpl = fetch, logger = console,
  timeoutSec = 30, retryDelayMs = 5000,
}) {
  let offset = 0;
  let stopped = false;

  async function pollOnce() {
    const res = await fetchImpl(
      `${API}/bot${token}/getUpdates?offset=${offset}&timeout=${timeoutSec}`);
    if (!res.ok) throw new Error(`getUpdates: HTTP ${res.status}`);
    const body = await res.json();
    if (!body.ok) throw new Error(`getUpdates: ${body.description ?? 'lỗi không rõ'}`);

    for (const update of body.result) {
      // Đẩy offset TRƯỚC khi xử lý — một tin xử lý lỗi không được làm cả
      // vòng polling đứng yên lặp lại đúng tin đó mãi mãi.
      offset = update.update_id + 1;
      const text = update.message?.text;
      const chatId = update.message?.chat?.id;
      if (!text || chatId === undefined) continue;

      // Chỉ trả lời đúng chat đã cấu hình — ai khác tìm ra bot qua username
      // cũng không đọc được dữ liệu hay đổi được gì của hệ thống.
      if (String(chatId) !== String(allowedChatId)) {
        logger.warn(`[telegram-poll] bỏ qua tin từ chat lạ: ${chatId}`);
        continue;
      }

      try {
        await onMessage(text);
      } catch (err) {
        logger.error(`[telegram-poll] lỗi xử lý tin nhắn: ${err.message}`);
      }
    }
  }

  async function start() {
    logger.info('[telegram-poll] bắt đầu polling...');
    while (!stopped) {
      try {
        await pollOnce();
      } catch (err) {
        logger.error(`[telegram-poll] lỗi polling: ${err.message}`);
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }

  function stop() { stopped = true; }

  // pollOnce lộ ra ngoài để test gọi từng nhịp có kiểm soát, không phải quay
  // vòng lặp vô hạn của start() rồi canh thời gian mới biết kết quả.
  return { start, stop, pollOnce, getOffset: () => offset };
}
