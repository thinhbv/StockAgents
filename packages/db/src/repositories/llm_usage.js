/**
 * Thống kê token mỗi lượt gọi LLM — một dòng cho MỖI lần provider.complete()
 * trả về (thành công hay bỏ lượt), để dashboard biết agent nào tốn bao
 * nhiêu, không chỉ tổng mà còn phân theo provider/model/mục đích.
 */

/**
 * WHERE thời gian dùng chung — `date` (một ngày VN cụ thể, "YYYY-MM-DD")
 * LẤN ÁT `sinceHours` khi có cả hai: chọn đúng một ngày nghĩa là muốn ĐÚNG
 * ngày đó, không phải "N giờ gần nhất" nữa. Biên ngày tính theo giờ VN (AT
 * TIME ZONE), không phải UTC — nếu không, 00:00-07:00 giờ VN sẽ bị tính
 * nhầm sang ngày hôm trước. Tham số cố định ($date, $sinceHours) ở MỌI lời
 * gọi, NULL thì nhánh tương ứng bị bỏ qua — tránh phải dựng chuỗi SQL khác
 * nhau tuỳ tham số nào có mặt.
 */
const TIME_WHERE = `(
  ($date::date IS NOT NULL
    AND created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' >= $date::date
    AND created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' < $date::date + 1)
  OR
  ($date::date IS NULL
    AND created_at > now() - (COALESCE($sinceHours, 168) || ' hours')::interval)
)`;

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
  async function totalsByAgent({ sinceHours = null, date = null } = {}) {
    const { rows } = await client.query(
      `SELECT agent_id,
              COUNT(*)::int AS requests,
              COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
              COUNT(*) FILTER (WHERE NOT succeeded)::int AS failed_requests
       FROM llm_usage
       WHERE ${TIME_WHERE.replaceAll('$date', '$1').replaceAll('$sinceHours', '$2')}
       GROUP BY agent_id
       ORDER BY agent_id`,
      [date, sinceHours],
    );
    return rows.map(r => ({
      agentId: r.agent_id, requests: r.requests,
      inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens), cacheWriteTokens: Number(r.cache_write_tokens),
      failedRequests: r.failed_requests,
    }));
  }

  /**
   * N lượt gần nhất — dùng cho bảng chi tiết/log trên dashboard. Không lọc
   * thời gian khi KHÔNG truyền date (mặc định cũ: chỉ cắt bằng `limit`) —
   * sinceHours ở đây chỉ có tác dụng khi gọi kèm date=null VÀ sinceHours
   * khác null, việc cắt theo "N giờ gần nhất" vốn không cần cho bảng log vì
   * limit đã đủ, nhưng vẫn hỗ trợ để nhất quán với totalsByAgent.
   */
  async function recent({ limit = 100, agentId = null, date = null, sinceHours = null } = {}) {
    const { rows } = await client.query(
      `SELECT id, agent_id, provider, model, purpose, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, succeeded, created_at
       FROM llm_usage
       WHERE ($3::text IS NULL OR agent_id = $3)
         AND (
           ($1::date IS NULL AND $4::int IS NULL)
           OR ${TIME_WHERE.replaceAll('$date', '$1').replaceAll('$sinceHours', '$4')}
         )
       ORDER BY created_at DESC LIMIT $2`,
      [date, limit, agentId, sinceHours],
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
