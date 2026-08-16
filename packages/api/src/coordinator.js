/**
 * Agent điều phối — trò chuyện qua Telegram về 5 agent đang chạy.
 *
 * Ranh giới cố ý, không phải thiếu sót:
 * - Chỉ đọc dữ liệu THẬT từ routes.js mỗi lượt, không bịa số liệu.
 * - Mọi thay đổi đi qua ĐÚNG con đường ghi đã có sẵn (config/agents.json
 *   qua routes.js) — không đụng DB, không tự đặt lệnh mua/bán thay agent,
 *   không sửa personaPrompt qua chat. Giữ nguyên chủ đích "agent tự lý luận,
 *   không ai định hướng trước" đã chốt trước đó — kể cả agent điều phối này
 *   cũng không được định hướng lại các agent kia bằng cách đổi persona.
 */

export const COORDINATOR_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    action: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['NONE', 'SET_MODEL', 'SET_RISK'] },
        agentId: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        maxPositionPctNav: { type: 'number' },
        dailyLossLimitPct: { type: 'number' },
      },
      required: ['type'],
    },
  },
  required: ['reply', 'action'],
};

export const SYSTEM_PROMPT = `Bạn là agent điều phối cho một hệ thống mô phỏng 5 agent AI tự động giao dịch cổ phiếu trên thị trường chứng khoán Việt Nam bằng tiền giả lập. Người dùng trò chuyện với bạn qua Telegram để theo dõi và điều chỉnh hệ thống.

Bạn CHỈ được dùng dữ liệu trong "Dữ liệu hệ thống hiện tại" được cung cấp mỗi lượt — không bịa số liệu, không suy đoán ngoài dữ liệu đó.

Bạn được phép thực hiện ĐÚNG hai loại điều chỉnh khi người dùng yêu cầu rõ ràng, trả về trong "action":
- SET_MODEL: đổi provider/model của một agent (agentId, provider, model).
- SET_RISK: đổi maxPositionPctNav (tỷ trọng tối đa một mã, %) và/hoặc dailyLossLimitPct (ngưỡng dừng lỗ trong ngày, %) của một agent (agentId, và ít nhất một trong hai giá trị).

Bạn KHÔNG được và không có khả năng: tự đặt lệnh mua/bán thay agent, đổi persona/phong cách của agent, hay xem/sửa bất kỳ thứ gì ngoài phạm vi trên. Nếu người dùng yêu cầu việc ngoài phạm vi này, giải thích rõ trong "reply" là bạn không làm được và vì sao — đừng giả vờ đã làm.

Không có điều chỉnh nào thì action = { "type": "NONE" }. Trả lời bằng tiếng Việt, ngắn gọn, đúng trọng tâm câu hỏi hoặc yêu cầu.`;

/** Gom dữ liệu hệ thống hiện tại cho một lượt hỏi — không có tool-calling
 * nhiều bước, nên gom đủ luôn một lần thay vì để agent điều phối tự xin
 * thêm; với chỉ 5 agent, kích thước này vẫn nhỏ. */
export async function buildSnapshot({ routes }) {
  const [session, { agents }, { events }] = await Promise.all([
    routes.session({ query: {} }),
    routes.leaderboard(),
    routes.events({ query: { since: 0, limit: 30 } }),
  ]);

  const perAgent = await Promise.all(agents.map(async (a) => {
    const [pos, dec] = await Promise.all([
      routes.positions({ params: { id: a.id } }),
      routes.decisions({ params: { id: a.id }, query: { limit: 10 } }),
    ]);
    return {
      id: a.id, name: a.name, provider: a.provider, model: a.model,
      nav: a.nav, totalReturnPct: a.totalReturnPct, dayPnl: a.dayPnl,
      positions: pos.positions, recentDecisions: dec.decisions,
    };
  }));

  return { session, agents: perAgent, recentEvents: events.slice(-30) };
}

export async function respond({ provider, message, history = [], snapshot }) {
  const messages = [
    ...history,
    { role: 'user', content: `Dữ liệu hệ thống hiện tại:\n${JSON.stringify(snapshot)}\n\nCâu hỏi/yêu cầu: ${message}` },
  ];
  const raw = await provider.complete({ system: SYSTEM_PROMPT, messages, jsonSchema: COORDINATOR_SCHEMA });
  // complete() trả mảng cho các agent giao dịch (nhiều quyết định/lượt);
  // agent điều phối chỉ có MỘT phản hồi/lượt nên bóc phần tử đầu nếu cần.
  const out = Array.isArray(raw) ? raw[0] : raw;
  if (!out || typeof out.reply !== 'string') {
    throw new Error('agent điều phối trả về sai khuôn — thiếu "reply"');
  }
  return { reply: out.reply, action: out.action ?? { type: 'NONE' } };
}

/**
 * Thực thi action — KHÔNG BAO GIỜ ném lỗi ra ngoài, luôn trả về một dòng
 * tiếng Việt (thành công hay lý do thất bại) để nối vào reply gửi người
 * dùng. Agent điều phối phải luôn biết kết quả thật, không phải im lặng.
 */
export async function applyAction({ routes, action }) {
  try {
    switch (action.type) {
      case 'NONE':
        return null;
      case 'SET_MODEL': {
        const r = await routes.updateAgentConfig({
          params: { id: action.agentId },
          body: { provider: action.provider, model: action.model },
        });
        return `✅ Đã đổi ${r.id} sang ${r.provider}/${r.model} — áp dụng từ phiên chạy tiếp theo.`;
      }
      case 'SET_RISK': {
        const r = await routes.updateAgentRisk({
          params: { id: action.agentId },
          body: {
            maxPositionPctNav: action.maxPositionPctNav,
            dailyLossLimitPct: action.dailyLossLimitPct,
          },
        });
        return `✅ Đã cập nhật rủi ro cho ${r.id}: ${JSON.stringify(r.riskConfig)} — áp dụng từ phiên chạy tiếp theo.`;
      }
      default:
        return `⚠️ Không nhận ra loại điều chỉnh "${action.type}" — bỏ qua.`;
    }
  } catch (err) {
    return `⚠️ Không thực hiện được: ${err.message}`;
  }
}
