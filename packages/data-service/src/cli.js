import { createClient, loadConfig } from '@stockagents/db';
import { createRepos } from './index.js';
import { runIngestPrices } from './jobs/ingest_prices.js';
import { runPollQuotes } from './jobs/poll_quotes.js';
import { runIngestFundamentals } from './jobs/ingest_fundamentals.js';
import { runPollIntradayFlow } from './jobs/poll_intraday_flow.js';

const COMMANDS = {
  async 'ingest-prices'({ repos }) {
    return runIngestPrices({ repos });
  },
  async 'poll-quotes'({ repos }) {
    const symbols = (await repos.universe.listActive()).map(s => s.symbol);
    return runPollQuotes({ repos, symbols });
  },
  // Cập nhật thủ công, bỏ qua giờ giao dịch — api server spawn lệnh này khi bấm nút trên dashboard.
  async 'poll-quotes-now'({ repos }) {
    const symbols = (await repos.universe.listActive()).map(s => s.symbol);
    return runPollQuotes({ repos, symbols, force: true });
  },
  async 'ingest-fundamentals'({ repos }) {
    return runIngestFundamentals({ repos });
  },
  async 'poll-intraday-flow'({ repos }) {
    const symbols = (await repos.universe.listActive()).map(s => s.symbol);
    return runPollIntradayFlow({ repos, symbols });
  },
};

const name = process.argv[2];
const command = COMMANDS[name];

if (!command) {
  console.error(`Lệnh không hợp lệ: ${name}`);
  console.error(`Có sẵn: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(1);
}

const cfg = loadConfig();
const client = createClient(cfg.databaseUrl);
const repos = createRepos(client);

command({ repos })
  .then(async (result) => {
    // Một dòng JSON: api server đọc lại stdout để lấy kết quả (xem runScript trong routes.js).
    console.log(JSON.stringify(result));
    await client.close();
  })
  .catch(async (err) => {
    console.error(err.stack || err.message);
    await client.close();
    process.exit(1);
  });
