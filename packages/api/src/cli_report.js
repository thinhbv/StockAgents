import { parseArgs } from 'node:util';
import {
  createClient, loadConfig, createAgentsRepo, createTradingRepo,
  createOpsRepo, createEventsRepo, createLessonsRepo,
} from '@stockagents/db';
import { createRoutes } from './routes.js';
import { createTelegramReporter } from './reporters/telegram.js';

const { values } = parseArgs({
  options: { date: { type: 'string' } },
  allowPositionals: true,
});

const tradeDate = values.date ?? new Date().toISOString().slice(0, 10);
const cfg = loadConfig();
const client = createClient(cfg.databaseUrl);

try {
  const repos = {
    agents: createAgentsRepo(client), trading: createTradingRepo(client),
    ops: createOpsRepo(client), events: createEventsRepo(client),
    lessons: createLessonsRepo(client),
  };
  const routes = createRoutes({ client, repos });

  const reporter = createTelegramReporter({
    token: process.env.TELEGRAM_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  });

  const result = await reporter.reportDay({ routes, tradeDate });

  // Luôn in ra bảng xếp hạng dù Telegram có gửi được hay không — báo cáo
  // hỏng không được làm mất thông tin.
  const { agents } = await routes.leaderboard({ query: {} });
  console.log(`\nTổng kết phiên ${tradeDate}\n`);
  for (const [i, a] of agents.entries()) {
    const pct = a.totalReturnPct;
    const mark = pct === null ? '·' : (pct > 0 ? '▲' : pct < 0 ? '▼' : '·');
    console.log(
      `  ${i + 1}. ${a.name.padEnd(20)} ${mark} ${(pct === null ? '—' : `${pct}%`).padStart(8)}` +
      `  NAV ${(a.nav === null ? '—' : a.nav.toLocaleString('vi-VN')).padStart(16)}` +
      `  ${a.positionCount} vị thế`);
  }
  console.log(`\nTelegram: ${result.sent ? 'đã gửi' : `không gửi (${result.reason})`}\n`);
} catch (err) {
  console.error(err.stack || err.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
