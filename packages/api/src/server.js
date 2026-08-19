import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createClient, createAgentsRepo, createTradingRepo,
  createOpsRepo, createEventsRepo, createLessonsRepo, createMarketRepo, createUniverseRepo,
} from '@stockagents/db';
import { loadApiConfig } from './config.js';
import { createRouter } from './router.js';
import { serveStatic } from './static.js';
import { createRoutes, HttpError } from './routes.js';
import { createSseHub } from './stream/sse.js';
import { createEventListener } from './stream/listener.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body không phải JSON hợp lệ');
  }
}

export function createServer({ config, logger = console }) {
  const client = createClient(config.readonlyUrl);
  const repos = {
    agents: createAgentsRepo(client), trading: createTradingRepo(client),
    ops: createOpsRepo(client), events: createEventsRepo(client),
    lessons: createLessonsRepo(client), market: createMarketRepo(client),
    universe: createUniverseRepo(client),
  };
  const routes = createRoutes({ client, repos });
  const hub = createSseHub({ eventsRepo: repos.events });

  const router = createRouter();
  router.get('/api/session', routes.session);
  router.get('/api/quotes', routes.quotes);
  router.get('/api/leaderboard', routes.leaderboard);
  router.get('/api/events', routes.events);
  router.get('/api/agents/:id', routes.agent);
  router.get('/api/agents/:id/positions', routes.positions);
  router.get('/api/agents/:id/decisions', routes.decisions);
  router.get('/api/agents/:id/lessons', routes.lessons);
  router.get('/api/agents/:id/history', routes.history);
  router.get('/api/config/catalog', routes.modelCatalog);
  router.get('/api/agents/:id/config', routes.agentConfig);
  router.patch('/api/agents/:id/config', routes.updateAgentConfig);

  // NOTIFY chỉ mang phong bì gọn; đọc bản đầy đủ từ event_log theo id.
  const listener = createEventListener({
    connectionString: config.readonlyUrl,
    onEnvelope: async ({ id }) => {
      const [full] = await repos.events.getEventsSince(id - 1, 1);
      if (full) hub.broadcast(full);
    },
    logger,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

      // API chỉ đọc, TRỪ đúng một cổng ghi: sửa provider/model của agent
      // trong config/agents.json (routes.updateAgentConfig). Mọi phương thức
      // khác GET ngoài route đó đều bị từ chối thẳng.
      const isConfigPatch = req.method === 'PATCH' && /^\/api\/agents\/[^/]+\/config$/.test(url.pathname);
      if (req.method !== 'GET' && !isConfigPatch) {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('API này chỉ đọc, trừ sửa provider/model agent — method không hỗ trợ');
      }

      if (config.token) {
        const given = url.searchParams.get('token') ?? req.headers['x-dashboard-token'];
        if (given !== config.token) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('thiếu hoặc sai DASHBOARD_TOKEN');
        }
      }

      if (url.pathname === '/api/stream') {
        const lastId = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0);
        return hub.attach(res, Number.isFinite(lastId) ? lastId : 0);
      }

      const match = router.resolve(url.pathname, req.method);
      if (match) {
        const body = isConfigPatch ? await readJsonBody(req) : undefined;
        const result = await match.handler({
          params: match.params,
          query: Object.fromEntries(url.searchParams),
          body,
        });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      }

      if (url.pathname.startsWith('/api/')) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'không có endpoint này' }));
      }

      const file = await serveStatic(PUBLIC_DIR, url.pathname);
      res.writeHead(file.status, file.headers);
      return res.end(file.body);

    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) logger.error(`[api] ${req.url}: ${err.stack ?? err.message}`);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  });

  async function listen() {
    await listener.start();
    await new Promise(resolve => server.listen(config.port, config.host, resolve));
    logger.info(`[api] dashboard tại http://${config.host}:${config.port}`);
  }

  async function close() {
    hub.stop();
    await listener.stop();
    await new Promise(resolve => server.close(resolve));
    await client.close();
  }

  return { listen, close, server, hub };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadApiConfig();
  const app = createServer({ config });
  await app.listen();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => { await app.close(); process.exit(0); });
  }
}
