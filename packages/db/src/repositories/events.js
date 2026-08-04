const NOTIFY_CHANNEL = 'agent_events';

function toEvent(row) {
  return {
    id: row.id,
    ts: row.ts,
    type: row.type,
    agentId: row.agent_id,
    symbol: row.symbol,
    payload: row.payload,
  };
}

export function createEventsRepo(client) {
  /**
   * Ghi event_log và phát NOTIFY trong CÙNG một câu lệnh.
   * Nguyên tử: không bao giờ có sự kiện đã ghi mà chưa báo, hoặc ngược lại.
   * Phong bì NOTIFY cố ý gọn — giới hạn của Postgres là 8000 byte,
   * còn payload đầy đủ thì consumer đọc lại từ event_log theo id.
   */
  async function appendEvent({ type, agentId = null, symbol = null, payload = {} }) {
    if (!type) throw new Error('appendEvent: type là bắt buộc');
    const { rows } = await client.query(
      `WITH ins AS (
         INSERT INTO event_log (type, agent_id, symbol, payload)
         VALUES ($1, $2, $3, $4)
         RETURNING id, ts, type, agent_id
       )
       SELECT ins.id, ins.ts,
              pg_notify($5, json_build_object(
                'id', ins.id, 'type', ins.type, 'agentId', ins.agent_id
              )::text)
       FROM ins`,
      [type, agentId, symbol, payload, NOTIFY_CHANNEL],
    );
    return { id: rows[0].id, ts: rows[0].ts };
  }

  async function getEventsSince(sinceId = 0, limit = 200) {
    const { rows } = await client.query(
      `SELECT id, ts, type, agent_id, symbol, payload
       FROM event_log WHERE id > $1 ORDER BY id ASC LIMIT $2`,
      [sinceId, limit],
    );
    return rows.map(toEvent);
  }

  async function pruneOlderThan(days) {
    if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
      throw new Error(
        `pruneOlderThan: days phải là một số hữu hạn lớn hơn 0, nhận được: ${days}`,
      );
    }
    const { rowCount } = await client.query(
      `DELETE FROM event_log WHERE ts < now() - ($1 || ' days')::interval`,
      [String(days)],
    );
    return rowCount;
  }

  return { appendEvent, getEventsSince, pruneOlderThan };
}
