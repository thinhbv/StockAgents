import * as core from 'tradingview-mcp/core';
import { createClient, loadConfig } from '@stockagents/db';
import { createBroker } from './cdp/broker.js';
import { createRepos } from './index.js';
import { runIngestPrices } from './jobs/ingest_prices.js';
import { runPollQuotes } from './jobs/poll_quotes.js';
import { runIngestFundamentals } from './jobs/ingest_fundamentals.js';

const COMMANDS = {
  async 'ingest-prices'({ broker, repos }) {
    return runIngestPrices({ broker, repos });
  },
  async 'poll-quotes'({ broker, repos }) {
    const symbols = (await repos.universe.listActive()).map(s => s.symbol);
    return runPollQuotes({ broker, repos, symbols });
  },
  // Không cần broker — gọi HTTP thẳng tới Vietcap, không qua CDP.
  async 'ingest-fundamentals'({ repos }) {
    return runIngestFundamentals({ repos });
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
const broker = createBroker({ core });

command({ broker, repos })
  .then(async (result) => {
    console.log(JSON.stringify(result, null, 2));
    await client.close();
  })
  .catch(async (err) => {
    console.error(err.stack || err.message);
    await client.close();
    process.exit(1);
  });
