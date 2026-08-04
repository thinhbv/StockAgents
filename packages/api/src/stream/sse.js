const HEARTBEAT_MS = 25_000;
const MAX_CLIENTS = 20;

/**
 * Quản lý client SSE.
 *
 * Mỗi message mang `id` bằng event_log.id. Khi trình duyệt mất kết nối,
 * EventSource tự nối lại kèm header Last-Event-ID, và ta phát lại phần
 * thiếu — nên không có khoảng trống giữa lịch sử và realtime.
 */
export function createSseHub({ eventsRepo, heartbeatMs = HEARTBEAT_MS, maxClients = MAX_CLIENTS }) {
  const clients = new Set();

  // Comment định kỳ để proxy không cắt kết nối vì tưởng đã chết.
  const heartbeat = setInterval(() => {
    for (const res of [...clients]) safeWrite(res, ': heartbeat\n\n');
  }, heartbeatMs);
  heartbeat.unref?.();

  function safeWrite(res, text) {
    try { res.write(text); return true; }
    catch { clients.delete(res); return false; }
  }

  function format(event) {
    // JSON.stringify escape mọi xuống dòng, nên `data:` luôn nằm trên một
    // dòng duy nhất — đúng khuôn SSE mà không cần tự chẻ dòng.
    return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  async function attach(res, lastEventId = 0) {
    if (clients.size >= maxClients) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('quá nhiều kết nối dashboard');
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });

    clients.add(res);
    res.on('close', () => clients.delete(res));

    // Phát lại phần đã bỏ lỡ TRƯỚC khi nối vào luồng trực tiếp.
    const missed = await eventsRepo.getEventsSince(lastEventId, 500);
    for (const e of missed) safeWrite(res, format(e));
  }

  function broadcast(event) {
    const text = format(event);
    for (const res of [...clients]) safeWrite(res, text);
  }

  function stop() {
    clearInterval(heartbeat);
    for (const res of [...clients]) { try { res.end(); } catch { /* đã đóng */ } }
    clients.clear();
  }

  return { attach, broadcast, clientCount: () => clients.size, stop };
}
