import pg from 'pg';

const CHANNEL = 'agent_events';
const RECONNECT_MS = 2_000;

/**
 * Nghe NOTIFY trên kênh agent_events.
 *
 * Dùng pg.Client riêng chứ không lấy từ pool: LISTEN gắn với MỘT kết nối cụ
 * thể, còn pool có thể trả về kết nối khác cho truy vấn sau và đăng ký sẽ
 * lặng lẽ biến mất.
 */
export function createEventListener({ connectionString, onEnvelope, logger = console }) {
  let client = null;
  let stopped = false;
  let retryTimer = null;

  async function connect() {
    if (stopped) return;
    client = new pg.Client({ connectionString });

    client.on('notification', (msg) => {
      try { onEnvelope(JSON.parse(msg.payload)); }
      catch (err) { logger.warn(`[listener] phong bì không đọc được: ${err.message}`); }
    });

    client.on('error', (err) => {
      logger.warn(`[listener] mất kết nối: ${err.message}`);
      scheduleReconnect();
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      logger.info(`[listener] đang nghe kênh ${CHANNEL}`);
    } catch (err) {
      logger.warn(`[listener] không kết nối được: ${err.message}`);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, RECONNECT_MS);
    retryTimer.unref?.();
  }

  async function stop() {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (client) { try { await client.end(); } catch { /* đã đóng */ } }
  }

  return { start: connect, stop };
}
