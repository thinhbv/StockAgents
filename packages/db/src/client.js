import pg from 'pg';

const { Pool } = pg;

// Postgres trả NUMERIC dạng string để không mất độ chính xác.
// Ta giữ nguyên hành vi đó cho tiền tệ, nhưng ép BIGINT (int8) về Number
// vì id sự kiện luôn nằm trong khoảng an toàn của JS.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

// node-pg (oid 1082 = DATE) mặc định parse thành Date object dựng từ
// NGÀY GIỜ ĐỊA PHƯƠNG của máy chạy Node, không phải UTC. Trên máy có múi giờ
// dương (vd Asia/Bangkok, Asia/Ho_Chi_Minh, UTC+7), gọi .toISOString() (quy về UTC)
// trên Date đó lùi lại một ngày (00:00 local -> 17:00 UTC hôm trước).
// Ta ép DATE trả về nguyên chuỗi 'YYYY-MM-DD' để tránh lệch ngày. Đăng ký ở đây
// (không phải trong repository riêng lẻ) vì đây là nơi duy nhất mọi module chạm
// DB đều import qua, nên hành vi parse DATE không phụ thuộc thứ tự import.
pg.types.setTypeParser(1082, (v) => v);

export function createClient(connectionString) {
  const pool = new Pool({ connectionString, max: 10 });

  async function query(text, params) {
    return pool.query(text, params);
  }

  async function withTransaction(fn) {
    const conn = await pool.connect();
    try {
      await conn.query('BEGIN');
      const result = await fn({ query: (t, p) => conn.query(t, p) });
      await conn.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await conn.query('ROLLBACK');
      } catch (rollbackErr) {
        err.rollbackError = rollbackErr;
      }
      throw err;
    } finally {
      conn.release();
    }
  }

  return { query, withTransaction, close: () => pool.end() };
}
