import { parseArgs } from 'node:util';
import { createClient, loadConfig, createTradingRepo } from '@stockagents/db';

/**
 * Reset một agent về "chơi lại từ đầu": xóa vị thế đang giữ, nạp lại đúng
 * vốn ban đầu. KHÔNG đụng tới lịch sử đã giao dịch (xem resetAgent() trong
 * packages/db/src/repositories/trading.js).
 *
 * Tồn tại như một tiến trình RIÊNG, không phải một route trong api server —
 * api server chỉ kết nối DB bằng role CHỈ ĐỌC (readonly_role.sql), cố ý
 * không có quyền ghi dù có lỗ hổng injection. Script này dùng DATABASE_URL
 * (quyền ghi đầy đủ), được api server spawn làm tiến trình con cho đúng MỘT
 * hành động — cùng khuôn với cách data-service spawn watch:tick.
 */
const { values } = parseArgs({
  options: { agent: { type: 'string' } },
  allowPositionals: true,
});

if (!values.agent) {
  console.error('Dùng: node cli_reset.js --agent <id>');
  process.exit(1);
}

const cfg = loadConfig();
const client = createClient(cfg.databaseUrl);

try {
  const result = await createTradingRepo(client).resetAgent(values.agent);
  console.log(JSON.stringify({ agentId: values.agent, ...result }));
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
