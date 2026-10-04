import { parseArgs } from 'node:util';
import { createClient, loadConfig, createAgentsRepo } from '@stockagents/db';
import { loadAgentDefs } from './agents/registry.js';
import { createProvider, availableProviders } from './llm/provider.js';
import { createOrchestrator } from './orchestrator/session.js';

/**
 * Watcher sống — chạy LẶP LẠI mỗi 5 phút (data-service gọi ngay sau
 * poll_quotes), khác hẳn cli_day.js/cli_all.js vốn nạp sẵn cả ngày rồi phát
 * lại 1 lượt. Mỗi lần gọi chỉ xử lý ĐÚNG 1 tick — tick mà poll_quotes vừa
 * ghi — nên không cần vòng lặp/tiến trình sống riêng: cứ để cron gọi lại.
 *
 * `--mode tick`  : mở phiên nếu chưa mở (giá tick ĐẦU ngày), rồi watchdog
 *                  tick 1 lần với giá MỚI NHẤT. Gọi mỗi 5 phút trong giờ.
 * `--mode close` : chốt sổ (mark-to-market + rút bài học) cho agent nào đã
 *                  mở mà chưa chốt hôm nay. Gọi 1 lần cuối phiên (~14:58).
 */
const { values } = parseArgs({
  options: {
    date: { type: 'string' },
    mode: { type: 'string' },
    stub: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (!values.date || !['tick', 'close'].includes(values.mode)) {
  console.error('Dùng: npm run watch:tick -- --date YYYY-MM-DD [--stub]');
  console.error('  hoặc npm run watch:close -- --date YYYY-MM-DD [--stub]');
  process.exit(1);
}

const cfg = loadConfig();
const client = createClient(cfg.databaseUrl);

try {
  const allDefs = await loadAgentDefs();
  await createAgentsRepo(client).upsertMany(allDefs);
  // upsertMany nhận ĐỦ danh sách để DB/dashboard biết agent tạm dừng vẫn tồn
  // tại (không xóa) — vòng giao dịch bên dưới thì chỉ xử lý agent active,
  // agent tạm dừng giữ nguyên trạng thái/vị thế, không mở lệnh mới.
  const defs = allDefs.filter(d => d.active !== false);

  if (!values.stub) {
    const have = availableProviders();
    const missing = [...new Set(defs.map(d => d.provider))].filter(p => !have.includes(p));
    if (missing.length > 0) {
      console.error(`Thiếu API key cho: ${missing.join(', ')}. Điền vào .env, hoặc chạy với --stub.`);
      process.exit(1);
    }
  }

  const orch = createOrchestrator({ client });
  const now = new Date();
  const summary = [];

  for (const def of defs) {
    const provider = createProvider({ provider: values.stub ? 'stub' : def.provider, model: def.model });

    if (values.mode === 'close') {
      if (!(await orch.hasOpenedToday(def.id, values.date))) {
        summary.push(`${def.id}: chưa mở phiên hôm nay, bỏ qua`);
        continue;
      }
      if (await orch.hasClosedToday(def.id, values.date)) {
        summary.push(`${def.id}: đã chốt sổ rồi`);
        continue;
      }
      const { universe } = await orch.buildWatchContext(provider);
      const priceMap = await orch.latestTickPriceMap(universe);
      const { close } = await orch.closeDay({
        agentId: def.id, agentDef: def, tradeDate: values.date, provider, priceMap,
      });
      summary.push(`${def.id}: chốt sổ, NAV ${close.nav.toLocaleString('vi-VN')} (${close.totalReturnPct}%)`);
      continue;
    }

    // ---- mode: tick ----
    if (await orch.hasClosedToday(def.id, values.date)) {
      summary.push(`${def.id}: đã chốt sổ, không theo dõi nữa`);
      continue;
    }

    if (!(await orch.hasOpenedToday(def.id, values.date))) {
      const { universe } = await orch.buildWatchContext(provider);
      const priceOverride = await orch.firstTickPriceMap(universe, values.date);
      if (priceOverride.size === 0) {
        summary.push(`${def.id}: chưa có tick nào hôm nay, chưa mở được`);
        continue;
      }
      const { opened, dataState } = await orch.openDay({
        agentId: def.id, agentDef: def, tradeDate: values.date, provider, priceOverride,
      });
      summary.push(opened ? `${def.id}: mở phiên (${dataState})` : `${def.id}: không mở phiên (${dataState})`);
      if (!opened) continue;
    }

    const { watchdog, universe, refPriceMap } = await orch.buildWatchContext(provider);
    const tickPriceMap = await orch.latestTickPriceMap(universe);
    if (tickPriceMap.size === 0) {
      summary.push(`${def.id}: chưa có giá, bỏ qua tick này`);
      continue;
    }
    const newsSentimentMap = await orch.latestNewsSentimentMap();

    const r = await watchdog.tick({
      agentId: def.id, agentDef: def, now, tradeDate: values.date,
      tickPriceMap, refPriceMap, universe, newsSentimentMap,
    });
    summary.push(
      `${def.id}: kiểm tra ${r.checked} vị thế, ${r.fired.length} trigger nổ` +
      `${r.autoSold.length > 0 ? `, ${r.autoSold.filter(s => s.status === 'FILLED').length} tự bán` : ''}` +
      `${r.woken > 0 ? ', 1 lượt hỏi LLM' : ''}`,
    );
  }

  console.log(`[watch:${values.mode}] ${values.date}\n${summary.map(s => `  ${s}`).join('\n')}`);
} catch (err) {
  console.error(err.stack || err.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
