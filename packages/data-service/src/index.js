import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  createClient, loadConfig, runMigrations,
  createUniverseRepo, createMarketRepo, createOpsRepo, createEventsRepo,
  createNewsRepo, createFundamentalsRepo, createIntradayFlowRepo,
} from '@stockagents/db';
import { startScheduler } from './scheduler.js';
import { nowVnDate, isTradingDay } from './lib/vn_time.js';
import { runIngestPrices } from './jobs/ingest_prices.js';
import { runPollQuotes } from './jobs/poll_quotes.js';
import { runPollIntradayFlow } from './jobs/poll_intraday_flow.js';
import { runPruneEvents } from './jobs/prune_events.js';
import { runIngestNews } from './jobs/ingest_news.js';
import { runIngestFundamentals } from './jobs/ingest_fundamentals.js';
import { loadNewsSources, loadMarketIndices } from './news/sources.js';

/**
 * Chạy một npm script trong tiến trình riêng.
 *
 * Giữ ranh giới giữa các package: data-service điều phối LỊCH, nhưng không
 * import agent-runtime hay api — chúng có vòng đời và phụ thuộc riêng.
 */
function spawnTask(script, args = []) {
  return new Promise((resolve) => {
    // shell: true trên Windows tra biến môi trường bằng đúng case 'ComSpec'.
    // PM2 dựng lại env cho tiến trình con và không giữ tính không-phân-biệt-
    // hoa-thường của Windows cho biến môi trường, key thường thành 'COMSPEC'
    // (toàn hoa) — Node tra 'ComSpec' không thấy, spawn báo ENOENT dù cmd.exe
    // vẫn tồn tại. Tự dò cả hai biến thể, có fallback cứng, thay vì để
    // Node/libuv tự đoán.
    const shell = process.platform === 'win32'
      ? (process.env.ComSpec || process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe')
      : true;
    const child = spawn('npm', ['run', script, '--', ...args], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      stdio: 'inherit', shell,
    });
    child.on('exit', (code) => {
      if (code !== 0) console.error(`[scheduler] ${script} thoát với mã ${code}`);
      resolve({ script, code });
    });
    child.on('error', (err) => {
      console.error(`[scheduler] không chạy được ${script}: ${err.message}`);
      resolve({ script, code: -1 });
    });
  });
}

export function createRepos(client) {
  return {
    universe: createUniverseRepo(client),
    market: createMarketRepo(client),
    ops: createOpsRepo(client),
    events: createEventsRepo(client),
    news: createNewsRepo(client),
    fundamentals: createFundamentalsRepo(client),
    intradayFlow: createIntradayFlowRepo(client),
  };
}

async function seedUniverse(repos) {
  const raw = await readFile(new URL('../../../config/universe.json', import.meta.url), 'utf8');
  const n = await repos.universe.upsertMany(JSON.parse(raw));
  console.log(`[data-service] universe: ${n} mã`);
}

async function main() {
  const cfg = loadConfig();
  const client = createClient(cfg.databaseUrl);
  // Tự áp dụng migration còn thiếu mỗi lần khởi động — khỏi phải nhớ chạy tay
  // `npm run migrate` trước mỗi lần bật lại (đã có lần quên: dashboard 500 vì
  // cột mới chỉ áp dụng cho DB test qua withTestDb(), chưa bao giờ chạy trên
  // DB thật). An toàn khi nhiều tiến trình (data-service/api/telegram-bot)
  // cùng gọi lúc khởi động — runMigrations() tự khoá advisory quanh cả đợt.
  await runMigrations(client);
  const repos = createRepos(client);

  await seedUniverse(repos);

  /**
   * Bọc một job để nó không chạy vào ngày nghỉ lễ.
   *
   * Cron `* * * * 1-5` chỉ loại được thứ Bảy và Chủ nhật. Nghỉ Tết rơi vào
   * thứ Ba thì sàn đóng nhưng cron vẫn bắn: ingest sẽ ghi lại đúng dữ liệu
   * của phiên hôm trước với `captured_at` của hôm nay — trông tươi nhưng
   * không phải, và cổng DATA_READY sẽ cho agent giao dịch trên nó.
   *
   * `poll_quotes` không cần bọc: nó đã tự kiểm tra qua `isTradingWindow`.
   */
  function onTradingDayOnly(name, fn) {
    return async () => {
      const holidays = await repos.ops.listHolidays();
      const today = nowVnDate();
      if (!isTradingDay(today, holidays)) {
        console.log(`[scheduler] ${today} không phải ngày giao dịch, bỏ qua ${name}`);
        return { skipped: true, reason: 'không phải ngày giao dịch' };
      }
      return fn();
    };
  }

  const scheduler = startScheduler({
    jobs: {
      ingest_prices: onTradingDayOnly('ingest_prices', () => runIngestPrices({ repos })),
      // Phase 1 chưa có vị thế nên poll toàn universe.
      // Phase 3 sẽ thay bằng hợp nhất các mã đang giữ của 5 agent.
      //
      // watch_tick chạy NỐI TIẾP ngay sau, không phải job cron riêng — nó
      // cần thấy đúng tick vừa ghi, đăng ký cron */5 riêng cho watch_tick sẽ
      // đua với poll_quotes (thứ tự hai job cùng lịch không được đảm bảo).
      // spawnTask() luôn được await nên poll_quotes chỉ coi là xong khi
      // watch_tick cũng xong — scheduler vẫn chỉ thấy 1 "job" đang chạy.
      poll_quotes: async () => {
        const symbols = (await repos.universe.listActive()).map(s => s.symbol);
        const result = await runPollQuotes({ repos, symbols });
        if (!result.skipped) {
          await spawnTask('watch:tick', ['--date', nowVnDate(), ...(cfg.simStub ? ['--stub'] : [])]);
        }
        return result;
      },
      // Nguồn VCI qua HTTP, độc lập CDP — không cần onTradingDayOnly, tự lọc
      // giờ giao dịch qua isTradingWindow như poll_quotes.
      poll_intraday_flow: async () => {
        const symbols = (await repos.universe.listActive()).map(s => s.symbol);
        return runPollIntradayFlow({ repos, symbols });
      },
      prune_events: () => runPruneEvents({ repos, retentionDays: cfg.eventLogRetentionDays }),

      ingest_fundamentals: onTradingDayOnly('ingest_fundamentals',
        () => runIngestFundamentals({ repos })),

      ingest_news: onTradingDayOnly('ingest_news', async () => {
        const sources = await loadNewsSources({ limit: 12 });
        return runIngestNews({ repos, sources, indices: () => loadMarketIndices() });
      }),

      // Chốt sổ cuối phiên (mark-to-market + rút bài học) cho agent nào đã
      // mở mà chưa chốt hôm nay — xem watch_tick ở trên cho việc mở/theo dõi.
      // Gọi qua tiến trình con để giữ ranh giới: data-service chỉ biết dữ
      // liệu, không biết agent nào đang giao dịch.
      //
      // --stub khi SIM_STUB=true: dùng cho lúc chưa có đủ API key cho mọi
      // provider — phiên tự động hằng ngày vẫn chạy trọn luồng (không tốn
      // token thật) cho tới khi tắt biến này.
      watch_close: onTradingDayOnly('watch_close',
        () => spawnTask('watch:close', ['--date', nowVnDate(), ...(cfg.simStub ? ['--stub'] : [])])),
      report_day: onTradingDayOnly('report_day',
        () => spawnTask('report:day', ['--date', nowVnDate()])),
    },
  });

  const shutdown = async (signal) => {
    console.log(`[data-service] nhận ${signal}, đang dừng...`);
    scheduler.stop();
    // Chờ job đang chạy dở xong trước khi đóng pool (Finding 2) — `stop()`
    // chỉ chặn các lần chạy TƯƠNG LAI, ingest có thể mất ~15s kể cả trên
    // đường lỗi, và một restart PM2 rơi đúng lúc đó sẽ đóng pool giữa chừng
    // một lần ghi DB nếu không có bước drain này.
    await scheduler.drain();
    await client.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log('[data-service] đã khởi động');
}

// Chỉ chạy scheduler khi file này là entry point.
// `cli.js` import `createRepos` từ đây — không có guard thì chạy CLI
// sẽ vô tình khởi động luôn scheduler.
//
// PM2 (fork mode) không spawn `node index.js` trực tiếp — nó spawn
// ProcessContainerFork.js rồi require() script đích từ bên trong, nên
// process.argv[1] trỏ tới wrapper của PM2 chứ không phải file này. So khớp
// import.meta.url với process.argv[1] vì vậy luôn sai dưới PM2 và main()
// không bao giờ chạy (guard tưởng đây không phải entry point). `pm_id` chỉ
// tồn tại trong process con do PM2 quản lý, dùng nó làm lối thoát cho case đó.
const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const isUnderPm2 = process.env.pm_id !== undefined;
if (isEntryPoint || isUnderPm2) {
  main().catch((err) => {
    console.error('[data-service] lỗi khởi động:', err);
    process.exit(1);
  });
}
