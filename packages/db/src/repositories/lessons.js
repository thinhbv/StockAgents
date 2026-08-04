import { assertAgentScope } from './_guard.js';

const num = (v) => (v === null || v === undefined ? null : Number(v));

function toLesson(r) {
  return {
    id: r.id, lesson: r.lesson, confidence: num(r.confidence),
    timesRetrieved: r.times_retrieved, timesHelped: r.times_helped,
    evidenceTradeIds: r.evidence_trade_ids, embedding: r.embedding,
    retired: r.retired, createdAt: r.created_at,
  };
}

export function createLessonsRepo(client) {
  async function insert(agentId, { lesson, confidence = 0.5, evidenceTradeIds = [], embedding = null }) {
    const id = assertAgentScope(agentId, 'insert');
    const { rows } = await client.query(
      `INSERT INTO lessons (agent_id, lesson, confidence, evidence_trade_ids, embedding)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [id, lesson, confidence, evidenceTradeIds, embedding ? JSON.stringify(embedding) : null]);
    return { id: rows[0].id };
  }

  /** Chỉ lesson CÒN HOẠT ĐỘNG của agent đó — retired không bao giờ quay lại prompt. */
  async function listActive(agentId, limit = 200) {
    const id = assertAgentScope(agentId, 'listActive');
    const { rows } = await client.query(
      `SELECT id, lesson, confidence, times_retrieved, times_helped,
              evidence_trade_ids, embedding, retired, created_at
       FROM lessons WHERE agent_id = $1 AND NOT retired
       ORDER BY confidence DESC, id DESC LIMIT $2`, [id, limit]);
    return rows.map(toLesson);
  }

  async function recordRetrieval(agentId, lessonId, tradeId) {
    const id = assertAgentScope(agentId, 'recordRetrieval');
    await client.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO lesson_usage (lesson_id, trade_id) VALUES ($1,$2)`, [lessonId, tradeId]);
      await tx.query(
        `UPDATE lessons SET times_retrieved = times_retrieved + 1
         WHERE id = $1 AND agent_id = $2`, [lessonId, id]);
    });
  }

  /** Ghi kết quả cho MỌI lesson đã được dùng cho lệnh này, rồi tính lại điểm. */
  async function applyOutcome(agentId, tradeId, helped, scoreFn) {
    const id = assertAgentScope(agentId, 'applyOutcome');
    const { rows } = await client.query(
      `SELECT l.id, l.times_helped, l.times_retrieved
       FROM lesson_usage u JOIN lessons l ON l.id = u.lesson_id
       WHERE u.trade_id = $1 AND l.agent_id = $2 AND u.outcome IS NULL`, [tradeId, id]);

    for (const r of rows) {
      const timesHelped = r.times_helped + (helped ? 1 : 0);
      const confidence = scoreFn({ timesHelped, timesRetrieved: r.times_retrieved });
      await client.query(
        `UPDATE lessons SET times_helped = $2, confidence = $3 WHERE id = $1`,
        [r.id, timesHelped, confidence]);
      await client.query(
        `UPDATE lesson_usage SET outcome = $2 WHERE trade_id = $1 AND lesson_id = $3`,
        [tradeId, helped ? 'HELPED' : 'MISSED', r.id]);
    }
    return rows.length;
  }

  async function retire(agentId, lessonId) {
    const id = assertAgentScope(agentId, 'retire');
    await client.query(
      `UPDATE lessons SET retired = TRUE WHERE id = $1 AND agent_id = $2`, [lessonId, id]);
  }

  async function pruneWeak(agentId, { below, minRetrievals }) {
    const id = assertAgentScope(agentId, 'pruneWeak');
    const { rowCount } = await client.query(
      `UPDATE lessons SET retired = TRUE
       WHERE agent_id = $1 AND NOT retired
         AND confidence < $2 AND times_retrieved >= $3`, [id, below, minRetrievals]);
    return rowCount;
  }

  return { insert, listActive, recordRetrieval, applyOutcome, retire, pruneWeak };
}
