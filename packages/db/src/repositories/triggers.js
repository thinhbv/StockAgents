import { assertAgentScope } from './_guard.js';

export function createTriggersRepo(client) {
  async function getLastFired(agentId, symbol, type) {
    const id = assertAgentScope(agentId, 'getLastFired');
    const { rows } = await client.query(
      `SELECT fired_at FROM trigger_log
       WHERE agent_id = $1 AND symbol = $2 AND type = $3`, [id, symbol, type]);
    return rows[0] ? rows[0].fired_at : null;
  }

  async function recordFired(agentId, symbol, type, firedAt) {
    const id = assertAgentScope(agentId, 'recordFired');
    await client.query(
      `INSERT INTO trigger_log (agent_id, symbol, type, fired_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (agent_id, symbol, type) DO UPDATE SET fired_at = EXCLUDED.fired_at`,
      [id, symbol, type, firedAt]);
  }

  async function listRecent(agentId, limit = 50) {
    const id = assertAgentScope(agentId, 'listRecent');
    const { rows } = await client.query(
      `SELECT symbol, type, fired_at AS "firedAt" FROM trigger_log
       WHERE agent_id = $1 ORDER BY fired_at DESC LIMIT $2`, [id, limit]);
    return rows;
  }

  return { getLastFired, recordFired, listRecent };
}
