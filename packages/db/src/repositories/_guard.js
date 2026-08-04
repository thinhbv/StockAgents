/**
 * Cưỡng chế nguyên tắc cô lập agent (spec §3.2).
 * Mọi hàm repository chạm bảng có agent_id PHẢI gọi hàm này trước tiên.
 * Cô lập bằng quy ước sẽ bị phá vỡ âm thầm; cô lập bằng code thì không.
 */
export function assertAgentScope(agentId, fnName) {
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw new Error(
      `${fnName}: agentId là bắt buộc và phải là chuỗi không rỗng. ` +
      `Truy vấn dữ liệu agent mà không giới hạn phạm vi sẽ làm rò rỉ giữa các agent.`,
    );
  }
  return agentId.trim();
}
