/**
 * Entry point `npm run telegram-bot` — agent điều phối trò chuyện qua
 * Telegram. Tiến trình độc lập, dài hạn, giống `data-service`/`api`: tự
 * polling, không phụ thuộc dashboard đang chạy hay không.
 *
 * Kết nối DB bằng role CHỈ ĐỌC (DATABASE_URL_READONLY) — mọi thay đổi thật
 * sự đều đi qua config/agents.json (routes.js::updateAgentConfig/
 * updateAgentRisk), không qua DB. Một lỗi/lỗ hổng ở tiến trình này vẫn
 * không thể sửa được danh mục hay lịch sử giao dịch.
 */
import {
  createClient, createAgentsRepo, createTradingRepo, createOpsRepo,
  createEventsRepo, createLessonsRepo, createMarketRepo,
} from '@stockagents/db';
import { createProvider } from '@stockagents/agent-runtime/src/llm/provider.js';
import { loadApiConfig } from './config.js';
import { createRoutes } from './routes.js';
import { createTelegramReporter } from './reporters/telegram.js';
import { createTelegramPoll } from './telegram_poll.js';
import { buildSnapshot, respond, applyAction } from './coordinator.js';

const MAX_HISTORY_TURNS = 10; // 10 cặp hỏi-đáp gần nhất — đủ mạch lạc, không phình vô hạn token mỗi lượt.

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) {
  console.error('Thiếu TELEGRAM_TOKEN hoặc TELEGRAM_CHAT_ID trong .env — không có gì để chạy.');
  process.exit(1);
}

const cfg = loadApiConfig();
const client = createClient(cfg.readonlyUrl);
const repos = {
  agents: createAgentsRepo(client), trading: createTradingRepo(client),
  ops: createOpsRepo(client), events: createEventsRepo(client),
  lessons: createLessonsRepo(client), market: createMarketRepo(client),
};
const routes = createRoutes({ client, repos });
const reporter = createTelegramReporter({ token, chatId });

const provider = createProvider({
  provider: process.env.COORDINATOR_PROVIDER ?? 'anthropic',
  model: process.env.COORDINATOR_MODEL ?? 'claude-sonnet-5',
});

let history = [];

async function onMessage(text) {
  const snapshot = await buildSnapshot({ routes });
  const { reply, action } = await respond({ provider, message: text, history, snapshot });
  const actionResult = await applyAction({ routes, action });

  history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
  if (history.length > MAX_HISTORY_TURNS * 2) history = history.slice(-MAX_HISTORY_TURNS * 2);

  await reporter.send(actionResult ? `${reply}\n\n${actionResult}` : reply);
}

const poll = createTelegramPoll({ token, allowedChatId: chatId, onMessage });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    poll.stop();
    await client.close();
    process.exit(0);
  });
}

console.log('[telegram-bot] agent điều phối sẵn sàng, đang lắng nghe Telegram...');
await poll.start();
