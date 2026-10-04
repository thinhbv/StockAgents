/**
 * Thống kê token mỗi lượt gọi LLM — một dòng cho MỖI lần provider.complete()
 * trả về (thành công hay bỏ lượt), để dashboard biết agent nào tốn bao
 * nhiêu, không chỉ tổng mà còn phân theo provider/model/mục đích.
 */
export function createLlmUsageRepo(client) {
  async function insertUsage({
    agentId, provider, model, purpose,
    inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0,
    succeeded = true,
  }) {
    await client.query(
      `INSERT INTO llm_usage
         (agent_id, provider, model, purpose, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, succeeded)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [agentId, provider, model, purpose, inputTokens, outputTokens,
        cacheReadTokens, cacheWriteTokens, succeeded],
    );
  }

  /** Tổng theo agent — dùng cho bảng tổng quan trên dashboard. */
  async function totalsByAgent({ sinceHours = 24 * 7 } = {}) {
    const { rows } = await client.query(
      `SELECT agent_id,
              COUNT(*)::int AS requests,
              COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
              COUNT(*) FILTER (WHERE NOT succeeded)::int AS failed_requests
       FROM llm_usage
       WHERE created_at > now() - ($1 || ' hours')::interval
       GROUP BY agent_id
       ORDER BY agent_id`,
      [sinceHours],
    );
    return rows.map(r => ({
      agentId: r.agent_id, requests: r.requests,
      inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens), cacheWriteTokens: Number(r.cache_write_tokens),
      failedRequests: r.failed_requests,
    }));
  }

  /** N lượt gần nhất — dùng cho bảng chi tiết/log trên dashboard. */
  async function recent({ limit = 100, agentId = null } = {}) {
    const { rows } = await client.query(
      `SELECT id, agent_id, provider, model, purpose, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, succeeded, created_at
       FROM llm_usage
       WHERE ($2::text IS NULL OR agent_id = $2)
       ORDER BY created_at DESC LIMIT $1`,
      [limit, agentId],
    );
    return rows.map(r => ({
      id: r.id, agentId: r.agent_id, provider: r.provider, model: r.model, purpose: r.purpose,
      inputTokens: r.input_tokens, outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens,
      succeeded: r.succeeded, createdAt: r.created_at,
    }));
  }

  return { insertUsage, totalsByAgent, recent };
}
