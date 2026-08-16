# SOURCE_INDEX.md

Chỉ mục mã nguồn của StockAgents: mỗi file, mỗi hàm được export, và ý nghĩa/lý do tồn tại của nó. Mục tiêu là giúp tìm nhanh "chức năng X nằm ở đâu, hàm nào" mà không phải đọc lại toàn bộ code.

Tài liệu này mô tả **implementation**. Về triết lý thiết kế tổng thể và các Phase, xem [README.md](README.md); về cách dùng hằng ngày, xem [docs/huong-dan-su-dung.md](docs/huong-dan-su-dung.md).

**Nguyên tắc nền tảng** (chi phối gần như mọi quyết định thiết kế dưới đây): hệ thống **chỉ giả lập khâu mua/bán** (khớp lệnh, tiền, vị thế). Giá, chỉ báo kỹ thuật, tin tức và lời gọi LLM đều phải là dữ liệu/lời gọi **thật** — không mock, kể cả khi mục đích chỉ là so sánh 5 agent với nhau. Cờ `--stub` chỉ dùng để chạy/test code, không phải chế độ vận hành bình thường.

## Kiến trúc gói

| Package | Vai trò | Ranh giới import |
|---|---|---|
| `packages/db` | Schema, migrations, repositories — tầng dữ liệu duy nhất | Không phụ thuộc package nào khác trong repo |
| `packages/data-service` | Thu thập dữ liệu thật: giá qua CDP/TradingView Desktop, tin tức VN | Chỉ `cdp/broker.js`, `index.js`, `cli.js` được import `tradingview-mcp`; mọi phần khác đọc/ghi qua `packages/db` |
| `packages/agent-runtime` | Mô phỏng giao dịch: context, LLM, engine khớp lệnh, orchestrator, learning | Đọc/ghi qua `packages/db`; không phụ thuộc `data-service` hay `api` |
| `packages/api` | Dashboard realtime — **chỉ đọc** (role DB `stockagents_ro`, chỉ có quyền SELECT) | Đọc qua `packages/db`; không phụ thuộc `agent-runtime` hay `data-service` |

## Bản đồ chức năng → file (theo Phase)

| Chức năng | File chính |
|---|---|
| Thu thập giá/chỉ báo thật qua TradingView | `data-service/cdp/broker.js`, `collectors/prices.js`, `collectors/indicators_calc.js`, `jobs/ingest_prices.js` |
| Cổng dữ liệu `DATA_READY/PARTIAL/STALE` | `data-service/jobs/ingest_prices.js`, `db/repositories/ops.js` |
| Mô phỏng một phiên (giá VND, phí, thuế, luật thị trường VN) | `agent-runtime/session.js`, `sim/vn_rules.js`, `sim/fees.js`, `sim/portfolio.js`, `sim/pnl.js`, `sim/engine.js`, `sim/guardrails.js` |
| Orchestrator trọn ngày + watchdog đánh thức theo sự kiện | `agent-runtime/orchestrator/session.js`, `orchestrator/watchdog.js`, `orchestrator/triggers.js` |
| Alert Center (mã chưa giữ biến động mạnh) | `agent-runtime/orchestrator/triggers.js::evaluateUniverseAlerts`, `orchestrator/watchdog.js` |
| Dashboard realtime (SSE, chỉ đọc) | `api/src/server.js`, `routes.js`, `stream/sse.js`, `stream/listener.js`, `public/app.js` |
| 5 agent / 4 provider LLM | `agent-runtime/agents/registry.js`, `llm/provider.js`, `llm/anthropic.js`, `llm/openai.js`, `llm/gemini.js`, `llm/deepseek.js`, `llm/stub.js`, `config/agents.json` |
| Memory / RAG / lesson scorer | `agent-runtime/memory/similarity.js`, `memory/retrieval.js`, `learning/scorer.js`, `learning/reflect.js`, `db/repositories/lessons.js` |
| Tin tức VN + sentiment từ điển + Telegram | `data-service/news/sources.js`, `news/sentiment.js`, `jobs/ingest_news.js`, `db/repositories/news.js`, `api/reporters/telegram.js`, `api/cli_report.js` |
| Agent điều phối — trò chuyện/điều chỉnh qua Telegram | `api/coordinator.js`, `api/telegram_poll.js`, `api/telegram_bot.js`, `api/routes.js::updateAgentRisk` |
| Vòng giao dịch, 6+1 chỉ số, biểu đồ NAV | `agent-runtime/sim/outcomes.js`, `sim/metrics.js`, `db/repositories/trading.js`, `api/public/app.js::renderNavChart` |
| Data-quality gate (chặn mua khi thiếu chỉ báo thật) | `agent-runtime/agents/context.js` (cờ `indicatorsMissing`), `sim/guardrails.js::checkBuy` |
| Bối cảnh vĩ mô dùng chung cho mọi agent | `agent-runtime/agents/context.js` (`market.indices`), `orchestrator/session.js` (sự kiện `market.snapshot`) |
| Thang điểm chung / hiệu chuẩn tin cậy giữa 5 agent | `agent-runtime/llm/decision_schema.js` (`confidence` bắt buộc), `sim/metrics.js::confidenceCalibration` |

---

# packages/db

Tầng dữ liệu duy nhất; mọi package khác đọc/ghi thông qua các repository ở đây, không tự viết SQL rải rác.

### `packages/db/src/client.js`
Bọc `pg.Pool` thành client dùng chung cho toàn bộ package `@stockagents/db`, kèm hai type-parser chỉnh sửa hành vi mặc định của `node-postgres` để tránh mất dữ liệu hoặc lệch ngày.

- `createClient(connectionString)` — trả về `{ query, withTransaction, close }`. `query(text, params)` chạy trực tiếp trên pool (không transaction). `withTransaction(fn)` mở một connection riêng từ pool, `BEGIN`, chạy `fn` với một `query` bị khoá vào đúng connection đó (không phải pool) để đảm bảo mọi câu lệnh trong `fn` cùng một transaction, `COMMIT` nếu thành công hoặc `ROLLBACK` nếu lỗi, rồi luôn `release()` connection về pool ở `finally`. `close()` đóng cả pool khi server/script tắt.
- Side-effect khi module này được import: đăng ký `pg.types.setTypeParser` cho hai oid. OID 20 (BIGINT) ép về `Number` vì id sự kiện luôn nằm trong khoảng an toàn của JS, còn NUMERIC (tiền tệ) giữ nguyên dạng string mặc định để không mất độ chính xác. OID 1082 (DATE) ép trả về **nguyên chuỗi `'YYYY-MM-DD'` thay vì `Date` object** — vì `node-pg` mặc định dựng `Date` theo giờ địa phương máy chạy Node, và `.toISOString()` (quy UTC) trên `Date` đó ở múi giờ dương như Asia/Ho_Chi_Minh sẽ lùi lại một ngày. Đăng ký ở đây (nơi duy nhất mọi module chạm DB đều import qua) để hành vi parse DATE không phụ thuộc thứ tự import.

### `packages/db/src/config.js`
Đọc cấu hình kết nối DB và tham số vận hành từ biến môi trường cho phía **ghi** (khác `packages/api/src/config.js` dành cho dashboard chỉ-đọc).

- `loadConfig(env)` — trả về object đóng băng gồm: `databaseUrl` (bắt buộc, từ `DATABASE_URL` — connection string có quyền ghi), `databaseUrlTest` (bắt buộc, từ `DATABASE_URL_TEST`, tách riêng để test không bao giờ chạm DB thật), `dataStalenessMinutes`, `eventLogRetentionDays`, `simStub` (cờ bật provider giả lập khi chưa đủ API key thật cho job `run_session` tự động hằng ngày), và `tz` cố định `'Asia/Ho_Chi_Minh'`. Ném lỗi ngay nếu thiếu biến bắt buộc hoặc biến số không parse được, để lỗi cấu hình lộ ra sớm.

### `packages/db/src/index.js`
Điểm export duy nhất ra ngoài package `@stockagents/db` — mọi consumer chỉ import qua đây, không import trực tiếp file trong `repositories/`.

- Re-export `createClient`, `runMigrations`, `loadConfig`, `assertAgentScope`, và factory của toàn bộ repository: `createUniverseRepo`, `createMarketRepo`, `createOpsRepo`, `createEventsRepo`, `createAgentsRepo`, `createTradingRepo`, `createTriggersRepo`, `createLessonsRepo`, `createNewsRepo`, `createFundamentalsRepo`.

### `packages/db/src/migrate.js`
Chạy các file migration SQL trong `packages/db/migrations/` theo đúng thứ tự tên file, chỉ áp dụng file chưa từng chạy.

- `runMigrations(client, { dir })` — tạo bảng `schema_migrations` nếu chưa có, đọc danh sách file `.sql` đã sắp xếp theo tên, bỏ qua file đã ghi nhận, còn lại chạy trong MỘT transaction rồi ghi tên file vào `schema_migrations` — SQL lỗi giữa chừng thì cả migration đó rollback. Chạy trực tiếp được qua `npm run migrate` (hoặc `--test` để nhắm `DATABASE_URL_TEST`).

### `packages/db/src/repositories/_guard.js`
Cơ chế cưỡng chế cô lập dữ liệu giữa các agent (spec §3.2), dùng chung cho mọi repository chạm bảng có cột `agent_id`.

- `assertAgentScope(agentId, fnName)` — ném lỗi nếu `agentId` không phải chuỗi khác rỗng, ngược lại trả về `agentId` đã `trim()`. Một hàm gác cổng duy nhất, bắt buộc gọi đầu mỗi truy vấn scoped, biến lỗi "quên truyền agentId" thành lỗi throw ngay lập tức thay vì một truy vấn âm thầm trả về dữ liệu của agent khác.

### `packages/db/src/repositories/agents.js`
Thông tin agent, tiền mặt, snapshot NAV theo ngày, và bảng chỉ số hiệu năng (`metrics_daily`).

- `upsertMany(list)` — nạp/cập nhật định nghĩa agent từ `config/agents.json`; tiền mặt khởi tạo chỉ đặt khi agent còn mới tinh (`cash_vnd = 0`) để chạy lại CLI không nạp lại tiền cho agent đang có vị thế; tạo luôn snapshot mốc bất biến `1970-01-01` làm chuẩn so sánh PnL cho phiên đầu.
- `get(agentId)` / `listActive()` — đọc thông tin một agent / danh sách id agent đang active.
- `getCash(agentId)` / `setCash(agentId, vnd)` — tiền mặt là TRẠNG THÁI hiện tại nằm trên `agents`, KHÔNG lấy từ snapshot (đọc/ghi qua snapshot sẽ làm hỏng chính mốc so sánh PnL ngày); `setCash` chặn giá trị âm (không đòn bẩy).
- `saveSnapshot` / `getSnapshot` / `getPreviousSnapshot` — snapshot NAV/tiền mặt/giá trị thị trường theo ngày; `getPreviousSnapshot` lấy phiên TRƯỚC `beforeDate` (không phải cùng ngày) — nếu lấy cùng ngày, chạy lại lần hai trong cùng phiên sẽ luôn cho `dayPnl = 0`.
- `listNavSeries(agentId)` — chuỗi NAV theo thời gian, BỎ mốc 1970-01-01 (đó là vốn ban đầu, không phải một phiên giao dịch — tính vào chuỗi lợi suất sẽ tạo một "ngày" giả).
- `saveMetrics(agentId, snapDate, m)` / `getMetrics(agentId, snapDate)` — lưu/đọc `metrics_daily` (gồm `totalReturnPct`, `winRate`, `sharpe`, `maxDrawdown`, `avgHoldingDays`, `tradeCount`, `confidenceCalibration`); idempotent qua `ON CONFLICT ... DO UPDATE`.

### `packages/db/src/repositories/events.js`
`event_log` — nguồn sự thật duy nhất cho mọi sự kiện realtime hiển thị trên dashboard, ghi và phát NOTIFY Postgres trong CÙNG một câu lệnh để không bao giờ có sự kiện đã ghi mà chưa báo (hoặc ngược lại).

- `appendEvent({ type, agentId, symbol, payload })` — insert vào `event_log` rồi `pg_notify` một "phong bì" gọn (chỉ `id`/`type`/`agentId`) trên kênh `agent_events` — giới hạn 8000 byte của NOTIFY buộc phải tách payload đầy đủ ra, consumer đọc lại theo `id` từ `event_log`.
- `getEventsSince(sinceId, limit)` — lấy sự kiện có `id > sinceId`, dùng cho cả nạp lịch sử ban đầu (`since=0`) lẫn phát lại phần bị lỡ khi SSE mất kết nối (`Last-Event-ID`).
- `pruneOlderThan(days)` — xoá sự kiện cũ hơn N ngày; validate `days` là số hữu hạn dương để cấu hình sai không vô tình xoá sạch bảng.

### `packages/db/src/repositories/lessons.js`
Bảng `lessons` — bài học agent tự rút ra sau mỗi lệnh, có điểm tin cậy (`confidence`) cập nhật dần theo kết quả thực tế.

- `insert(agentId, { lesson, confidence, evidenceTradeIds, embedding })` — ghi lesson mới, `confidence` mặc định 0.5 (trung lập).
- `listActive(agentId, limit)` — chỉ trả lesson CHƯA retired, sắp theo `confidence` giảm dần.
- `recordRetrieval(agentId, lessonId, tradeId)` — ghi nhận lesson được dùng cho một lệnh (`lesson_usage`) và tăng `times_retrieved`, trong cùng transaction để hai thay đổi không lệch nhau.
- `applyOutcome(agentId, tradeId, helped, scoreFn)` — sau khi biết kết quả lệnh, cập nhật `times_helped`/`confidence` cho từng lesson từng dùng cho `tradeId` bằng `scoreFn` (hàm chấm điểm truyền từ ngoài — tách khỏi repository để logic "thế nào là lesson tốt" không khoá cứng trong tầng DB), đánh dấu `outcome` để không tính lại hai lần.
- `retire(agentId, lessonId)` — ngừng dùng một lesson (không xoá, giữ lịch sử).
- `pruneWeak(agentId, { below, minRetrievals })` — tự động retire hàng loạt lesson yếu, chỉ với lesson đã đủ `minRetrievals` lần thử.

### `packages/db/src/repositories/market.js`
Dữ liệu thị trường thô: nến OHLCV, snapshot chỉ báo kỹ thuật, tick giá, chỉ số thị trường (VN-Index...).

- `upsertOhlcvBars(symbol, bars)` — ghi nhiều bar trong một transaction, `ON CONFLICT (symbol, trade_date)` cập nhật nếu trùng ngày.
- `getLatestBar(symbol)` — bar gần nhất của một mã.
- `insertIndicatorSnapshot(symbol, payload)` — ghi một bản chụp chỉ báo kỹ thuật tại một thời điểm.
- `getLatestIndicatorAgeMinutes()` — tuổi (phút) của mã **CŨ NHẤT** có snapshot trong universe đang bật, không phải mã mới nhất — lấy MAX toàn cục sẽ sai vì một mã tươi che giấu 29 mã cũ. Trả `null` khi không xác định được độ tươi cho toàn universe.
- `insertQuoteTicks(ticks)` — ghi nhiều tick giá trong một transaction.
- `insertIndexSnapshots(indices)` / `getLatestIndices(limit)` — ghi/đọc snapshot chỉ số thị trường; `getLatestIndices` lấy bản mới nhất mỗi `index_code`, dùng làm bối cảnh vĩ mô dùng chung bơm vào context mọi agent và đẩy lên dashboard qua sự kiện `market.snapshot`.

### `packages/db/src/repositories/news.js`
Bảng `news_items` — tin tức thị trường dùng chung cho mọi agent, không có khái niệm "sở hữu theo agent" nên cố tình **không** gọi `assertAgentScope`.

- `upsertMany(items)` — chèn nhiều tin, dùng `url` làm khoá tự nhiên (`ON CONFLICT (url) DO UPDATE`); chỉ ghi đè `sentiment` nếu bản mới có giá trị, tránh một lần crawl lại thiếu điểm sentiment xoá mất điểm đã có.
- `listRecent({ symbol, since, limit })` — lấy tin gần đây, lọc theo mã và mốc thời gian tuỳ chọn.
- `worstSentimentBySymbol({ since })` — với mỗi mã, lấy sentiment THẤP NHẤT (MIN) trong khung thời gian — cố ý không lấy trung bình, vì một tin cực xấu bị pha loãng bởi vài tin trung tính không được phép biến mất khỏi tín hiệu; đây là dữ liệu watchdog dùng để quyết định đánh thức agent giữa phiên vì tin xấu.

### `packages/db/src/repositories/fundamentals.js`
Bảng `fundamentals_snapshot` — chỉ số tài chính cơ bản theo quý (P/E, P/B, ROE, ROA, cổ tức, nợ/vốn chủ, vốn hoá...) cho từng mã, dùng chung cho mọi agent giống `news.js` nên cũng không gọi `assertAgentScope`.

- `insertSnapshot(symbol, payload)` — ghi một bản chụp chỉ số tài chính tại một thời điểm (`captured_at = now()`), không upsert — mỗi lần ingest là một bản ghi mới để giữ lịch sử.
- `getLatest(symbol)` — bản chụp mới nhất của một mã, `null` nếu chưa có.
- `getLatestForSymbols(symbols)` — bản mới nhất mỗi mã trong danh sách (`SELECT DISTINCT ON (symbol) ... ORDER BY symbol, captured_at DESC`), trả `Map<symbol, payload>`; MỘT câu truy vấn cho cả universe thay vì N câu, giống cách `news.js` được dùng trong context.js. Mảng rỗng trả `Map` rỗng ngay, không query.

### `packages/db/src/repositories/ops.js`
Trạng thái vận hành cấp hệ thống: `session_state` (cổng dữ liệu quyết định có mở phiên hay không) và `market_holidays`.

- `setSessionState(tradeDate, state, { dataCapturedAt, note })` — upsert trạng thái dữ liệu của một ngày; `dataCapturedAt` chỉ ghi đè khi có giá trị mới, để một lần chạy `DATA_PARTIAL`/`DATA_STALE` sau đó không xoá mất mốc `DATA_READY` gần nhất.
- `getSessionState(tradeDate)` — orchestrator dựa vào đây để quyết định có mở phiên.
- `logIngestError(job, symbol, message)` / `countIngestErrorsSince(since)` — ghi/đếm lỗi ingest, cắt message ở 2000 ký tự.
- `listHolidays()` — trả `Set<string>` (không phải mảng) vì phía gọi tra cứu mỗi nhịp poll; đọc lại từ bảng mỗi lần thay vì hardcode, vì lịch nghỉ lễ VN do Chính phủ công bố hằng năm.

### `packages/db/src/repositories/trading.js`
Tầng dữ liệu lõi cho vòng đời một lệnh: order → fill → position (+ position_lots cho T+2) → trade (log quyết định) → trade_outcome (vòng mua-bán đã ghép).

- `insertOrder` / `rejectOrder` / `fillOrder` / `listOpenOrders` — vòng đời một lệnh LIMIT; `fillOrder` ghi `fills` và đổi `orders.status` trong CÙNG một transaction.
- `getOpenPositions` / `getPosition` / `upsertPosition` — vị thế đang mở; `upsertPosition` dùng `ON CONFLICT (agent_id, symbol) WHERE closed_at IS NULL` — chỉ một vị thế MỞ cho mỗi (agent, mã) tại một thời điểm.
- `addLot` / `listLots` / `consumeLots` — mô hình lô mua riêng biệt cho T+2; `consumeLots` tiêu lô FIFO khi bán — thiếu bước này thì `position_lots` lệch vĩnh viễn với `positions`.
- `closePosition` — đánh dấu vị thế đã đóng khi bán hết.
- `insertTrade` / `listTrades` — log mỗi quyết định MUA/BÁN đã khớp, kèm `reason`, `confidence` (0..1, nay bắt buộc), `trigger` nguồn gốc.
- `insertOutcome` / `listOutcomeExitIds` / `listOutcomes` — vòng mua-bán trọn vẹn do `sim/outcomes.js::recordOutcomes` ghép; `listOutcomes` JOIN thêm `trades.confidence` (alias `entryConfidence`) để `sim/metrics.js::confidenceCalibration` so được độ tự tin lúc vào lệnh với kết quả thắng/thua.

### `packages/db/src/repositories/triggers.js`
`trigger_log` — thời điểm nổ gần nhất của mỗi (agent, mã, loại trigger), dùng cho cơ chế chống rung (debounce) 30 phút.

- `getLastFired(agentId, symbol, type)` / `recordFired(agentId, symbol, type, firedAt)` — dùng chung cho cả trigger trên vị thế đang giữ (TAKE_PROFIT...) lẫn alert trên mã chưa giữ (PRICE_MOVE, NEWS_ALERT).
- `listRecent(agentId, limit)` — lịch sử trigger gần đây của một agent.

### `packages/db/src/repositories/universe.js`
Danh sách mã cổ phiếu đang theo dõi — universe cố định dùng chung cho cả 5 agent để so sánh hiệu năng công bằng.

- `listActive()` — mọi mã đang `active = TRUE`, sắp theo mã.
- `upsertMany(symbols)` — nạp/cập nhật danh sách mã từ `config/universe.json`; không có hàm xoá mã, chỉ tắt qua `active`.

---

# packages/data-service

Thu thập dữ liệu THẬT: giá qua TradingView Desktop (CDP), tin tức VN. Đây là package duy nhất được phép biết tới `tradingview-mcp` — mọi package khác chỉ đọc kết quả đã lưu trong DB.

### `packages/data-service/src/index.js`
Entry point khởi động data-service: nạp cấu hình, mở kết nối DB, dựng broker CDP, seed universe, đăng ký toàn bộ job vào scheduler với vòng đời tắt an toàn.

- `createRepos(client)` — dựng bộ repository (universe, market, ops, events, news, fundamentals) từ một client DB; `cli.js` tái sử dụng để không lặp lại danh sách repo mỗi nơi cần.
- `main()` (nội bộ, không export) — seed universe từ `config/universe.json`; bọc các job phụ thuộc phiên giao dịch (`ingest_prices`, `ingest_news`, `run_session`, `report_day`) bằng `onTradingDayOnly` để cron `* * * * 1-5` (vốn chỉ loại được cuối tuần) không chạy nhầm vào ngày nghỉ lễ — chạy nhầm sẽ ghi lại dữ liệu phiên hôm trước với `captured_at` hôm nay, trông tươi nhưng không phải, và cổng `DATA_READY` sẽ cho agent giao dịch trên dữ liệu cũ. `poll_quotes` không cần bọc vì đã tự lọc giờ qua `isTradingWindow`. Nhận SIGINT/SIGTERM thì gọi `scheduler.drain()` trước khi đóng pool, để job đang ghi DB không bị cắt ngang bởi restart PM2. `run_session`/`report_day` gọi qua tiến trình con (`spawnTask`) để giữ ranh giới package.

### `packages/data-service/src/cli.js`
Script chạy tay một job ingest đơn lẻ (`ingest-prices` hoặc `poll-quotes`) từ dòng lệnh, dùng để debug/backfill mà không cần đợi cron.

- Không export (script thực thi trực tiếp). Bảng `COMMANDS` ánh xạ tên lệnh CLI sang `runIngestPrices`/`runPollQuotes` với `broker`/`repos` dựng sẵn.

### `packages/data-service/src/scheduler.js`
Đăng ký job định kỳ bằng `node-cron` theo giờ Việt Nam, đảm bảo một job lỗi không làm sập tiến trình và job đang chạy dở luôn được chờ xong trước khi tắt hệ thống.

- `SCHEDULES` — `ingest_prices` 08:30, `ingest_fundamentals` 08:35, `ingest_news` 08:45, `run_session` 09:15, `report_day` 15:00, `poll_quotes` mỗi 5 phút trong 09:00–14:55, `prune_events` 02:00.
- `startScheduler({ jobs, cronLib, logger })` — xác thực TRƯỚC KHI đăng ký bất kỳ job nào (nếu kiểm tra nằm trong vòng lặp đăng ký, một lỗi ở job thứ ba sẽ để lại hai job đầu có timer thật chạy mà không còn handle để `stop()`); `cronLib` tiêm vào để test không chờ đồng hồ thật; job ném lỗi bị nuốt và log thay vì crash tiến trình. Trả `{ stop, drain }`.
  - `stop()` — dừng mọi cron task; chỉ chặn lần chạy TƯƠNG LAI.
  - `drain(timeoutMs = 30000)` — chờ job đang chạy dở xong trước khi cho phép đóng pool, có timeout để job kẹt không chặn shutdown vô thời hạn.

### `packages/data-service/src/cdp/broker.js`
Điểm truy cập DUY NHẤT tới TradingView Desktop qua CDP trong toàn hệ thống.

TradingView Desktop chỉ có một chart hoạt động duy nhất và `setSymbol` đổi trạng thái toàn cục của chart — hai lời gọi song song sẽ đọc nhầm dữ liệu của nhau. Broker giải quyết bằng một promise-chain mutex nội bộ: mọi việc được nối tuần tự vào hàng đợi.

- `class BrokerError` — lỗi riêng mang theo `symbol`, số lần `attempts` đã thử, và `cause` gốc.
- `createBroker({ core, logger, maxRetries, baseDelayMs, sleep, symbolTimeoutMs, symbolPollMs })` — trả `{ run, withSymbol, ensureConnected, stats }`.
  - `run(fn)` — xếp hàng chạy `fn(core)`, không cần đổi symbol trước.
  - `withSymbol(symbol, fn)` — chuyển chart sang đúng mã (dùng `waitForSymbol` nội bộ thay `waitForChartReady` mặc định — vì sau khi `ensureStudies` thêm chỉ báo lên chart, phần tử DOM dùng để so khớp symbol hiển thị tên chỉ báo chứ không còn là mã); so khớp bằng ticker đã bỏ tiền tố sàn vì TradingView tự chuẩn hoá `'HOSE:FPT'` thành `'HOSE_DLY:FPT'`. Retry tối đa `maxRetries` lần với backoff nhân đôi; hết lượt vẫn lỗi thì ném `BrokerError`.
  - `ensureConnected()` — kiểm CDP qua `healthCheck()`, tự thử `launch()` nếu chưa sẵn sàng; trả `false` (không ném lỗi) nếu vẫn không kết nối được, để `ingest_prices` tự quyết định chuyển session sang `DATA_STALE`.
  - `stats()` — số việc đang chờ/đã xong/đã lỗi trong hàng đợi.

### `packages/data-service/src/cdp/studies.js`
Đảm bảo 5 chỉ báo kỹ thuật bắt buộc (RSI, MA20, MACD, Bollinger Bands, ATR) đã có trên chart TradingView, chạy một lần khi data-service khởi động.

- `REQUIRED_STUDIES` — 5 chỉ báo cần thêm; `Moving Average Simple` truyền tường minh `{ length: 20 }` (nếu không, TradingView tạo study ở chu kỳ mặc định 9, không phải 20). Bốn chỉ báo còn lại dùng mặc định TradingView (đã khớp đúng spec: RSI 14, MACD 12/26/9, Bollinger 20/2, ATR 14).
- `ensureStudies(broker)` — đọc study hiện có qua `chart.getState()`, chỉ thêm study còn thiếu (so theo `name`).

### `packages/data-service/src/collectors/prices.js`
Lấy nến OHLCV hằng ngày cho một mã qua broker và chuẩn hoá về hình dạng repository cần.

- `collectPrices(broker, symbol, { count = 60 })` — gọi `core.data.getOhlcv`; `volume` được làm tròn vì TradingView trả số thập phân cho một số mã trong khi cột DB là `BIGINT`. Mỗi trường số được kiểm `Number.isFinite` tường minh vì cả `node-pg` lẫn `NUMERIC` của Postgres đều chấp nhận giá trị `'NaN'` (thậm chí qua được ràng buộc `CHECK (v > 0)`).

### `packages/data-service/src/collectors/quotes.js`
Poll giá hiện tại (tick) cho một danh sách mã, dùng cho job chạy mỗi 5 phút.

- `collectQuotes(broker, symbols)` — một mã lỗi được gom vào `errors` riêng, không chặn batch. Tự đối chiếu `q.symbol` trả về với mã yêu cầu — nếu chart chưa chuyển mã xong, `getQuote` vẫn đọc được giá mã CŨ mà không báo lỗi. Giá lấy từ `q.last ?? q.close` (API không có trường `price`).

### `packages/data-service/src/collectors/indicators.js`
Đọc trực tiếp giá trị chỉ báo từ Data Window của TradingView qua `getStudyValues()` — hiện chỉ còn dùng trong test; luồng ingest thật đã chuyển sang `indicators_calc.js`.

- `REQUIRED_INDICATOR_KEYS` — 4 khoá tối thiểu (`rsi14`, `macd`, `bbBasis`, `atr14`) để một lần thu thập được coi là thành công.
- `parseStudyValues(studies)` — ánh xạ mảng study thô sang object phẳng, tự parse số (bỏ dấu phân cách nghìn, xử lý hậu tố K/M/B).
- `collectIndicators(broker, symbol)` — gọi `getStudyValues()`, parse rồi kiểm đủ khoá bắt buộc; thiếu thì ném lỗi.

### `packages/data-service/src/collectors/indicators_calc.js`
Tự tính chỉ báo kỹ thuật (hàm thuần, không gọi TradingView) từ chuỗi OHLCV đã lưu — **đây là đường dẫn thật** `jobs/ingest_prices.js` dùng.

Lý do không đọc trực tiếp từ TradingView: `getStudyValues()` chỉ điền dữ liệu khi có con trỏ chuột trên chart — chạy tự động lúc 8h30 không ai ngồi trước máy thì trả rỗng (đã kiểm chứng: chart có RSI hiển thị nhưng hàm chỉ trả `["Volume"]`).

- `REQUIRED_INDICATOR_KEYS` — 4 khoá bắt buộc, giống `collectors/indicators.js`.
- `sma(values, period)` — trung bình động đơn giản; `null` nếu chưa đủ dữ liệu.
- `ema(values, period)` — trung bình động luỹ thừa, mồi bằng SMA của `period` phần tử đầu.
- `rsi(closes, period = 14)` — làm mượt kiểu Wilder: `(prev*(n-1)+current)/n`, không phải trung bình cộng thông thường.
- `macd(closes, { fast, slow, signal })` — EMA nhanh trừ EMA chậm; đường signal là EMA của chính MACD.
- `bollinger(closes, { period, mult })` — SMA ± `mult` lần độ lệch chuẩn TOÀN PHẦN (chia n).
- `atr(bars, period = 14)` — ATR kiểu Wilder trên true range.
- `computeIndicators(bars)` — gộp mọi chỉ báo trên (+ `volume`, `volumeMa20`) thành đúng hình dạng `indicator_snapshot.payload`.

### `packages/data-service/src/jobs/ingest_prices.js`
Job 08:30: ingest OHLCV + tính chỉ báo cho toàn universe, quyết định `session_state` cho ngày giao dịch.

- `runIngestPrices({ broker, repos, logger, barCount = 60 })` — `ensureConnected()` thất bại thì đặt ngay `DATA_STALE`, không thử mã nào. Lặp qua từng mã: lấy bars, ghi `ohlcv_daily`, TỰ TÍNH chỉ báo (`computeIndicators`); một mã lỗi chỉ vào `failedSymbols`, không chặn mã khác. `session_state` cuối cùng: `DATA_READY` chỉ khi TOÀN BỘ mã thành công VÀ chỉ báo tính được; `DATA_PARTIAL` khi một phần thành công; `DATA_STALE` khi không mã nào thành công. `dataCapturedAt` chỉ cập nhật khi `DATA_READY` (chạy dở dang không làm mới dấu thời gian).

### `packages/data-service/src/jobs/poll_quotes.js`
Job mỗi 5 phút trong 09:00–14:55, poll giá tick cho danh sách mã theo dõi.

- `runPollQuotes({ broker, repos, symbols, logger, now })` — biểu thức cron cố tình đơn giản nhưng rộng hơn giờ giao dịch thật (gồm cả nghỉ trưa và hai đầu ngày), nên tự lọc chính xác bằng `isTradingWindow` thay vì mã hoá vào cron. Lịch nghỉ lễ đọc lại từ DB mỗi lần chạy (không cache). Trả `{ inserted, failed }` hoặc `{ skipped: true }` nếu ngoài giờ.

### `packages/data-service/src/jobs/ingest_news.js`
Job 08:45: thu tin tức tiếng Việt vào `news_items`, kèm chỉ số thị trường (dùng chung nguồn và nhịp chạy).

- `runIngestNews({ repos, sources, indices, logger, embedder })` — `sources` tiêm vào để test không gọi mạng thật. Với mỗi bài: giải mã thực thể HTML (`decodeEntities`) TRƯỚC khi chấm điểm/dò mã, dò mã liên quan (`detectSymbol`), chấm sentiment (`scoreSentiment`) trên tiêu đề + tóm tắt. Một nguồn lỗi chỉ vào `failedSources`, không chặn nguồn khác. Ghi sự kiện `news.ingested` kèm thống kê.

### `packages/data-service/src/collectors/fundamentals.js`
Lấy chỉ số tài chính cơ bản cho một mã từ API công khai VCI (Vietcap) — dò ra qua đọc mã nguồn thư viện `vnstock`, không cần đăng nhập, chỉ cần header giống trình duyệt (Referer/Origin/User-Agent).

- `pickRatios(r)` (nội bộ) — lọc chỉ giữ field dùng để phân tích (`pe`, `pb`, `ps`, `roe`, `roa`, `dividendYield`, `debtToEquity`, `currentRatio`, `grossMargin`, `marketCap`, `yearReport`, `quarter`), bỏ field chỉ có nghĩa với ngân hàng (`car`, `npl`...).
- `tickerOf(symbol)` (nội bộ) — bóc tiền tố sàn (`'HOSE:FPT'` → `'FPT'`) vì API nhận ticker trần.
- `collectFundamentals(symbol, fetchImpl = fetch)` — gọi `GET .../company/{ticker}/statistics-financial`, tự tìm bản MỚI NHẤT theo `(yearReport, quarter)` bằng `reduce` — không tin thứ tự mảng API trả về. Ném lỗi rõ khi HTTP lỗi hoặc data rỗng, không trả giá trị rác.
- `collectFundamentalsBatch(symbols, fetchImpl = fetch)` — một mã lỗi vào `errors`, không chặn mã khác; trả `{ snapshots, errors }`.

### `packages/data-service/src/jobs/ingest_fundamentals.js`
Job 08:35 (giữa `ingest_prices` 08:30 và `ingest_news` 08:45): thu chỉ số tài chính cơ bản cho toàn universe.

- `runIngestFundamentals({ repos, logger, fetchImpl })` — lặp `repos.universe.listActive()`, gọi `collectFundamentalsBatch`, ghi từng snapshot qua `repos.fundamentals.insertSnapshot`, log lỗi qua `repos.ops.logIngestError`, phát sự kiện `fundamentals.ingested`. KHÔNG đụng tới `session_state` — best-effort, không chặn phiên giao dịch nếu API bên ngoài lỗi (khác với `ingest_prices`, đây không phải dữ liệu bắt buộc để mở phiên).

### `packages/data-service/src/jobs/prune_events.js`
Job 02:00, xoá bản ghi `event_log` cũ hơn số ngày lưu trữ cấu hình.

- `runPruneEvents({ repos, retentionDays, logger })` — gọi `repos.events.pruneOlderThan(retentionDays)`, log số bản ghi đã xoá.

### `packages/data-service/src/news/sources.js`
Điểm chạm DUY NHẤT biết tới các module nguồn tin trong `tradingview_mcp/news/sources/`.

- `loadNewsSources({ limit = 12, logger })` — nạp động 6 module nguồn tin VN (cafef, vnexpress, vietstock, vneconomy, vietnambiz, tinnhanh); nguồn không nạp được thì BỎ QUA (vì `tradingview_mcp` là repo riêng có thể đổi cấu trúc); không nạp được nguồn nào cả thì ném lỗi.
- `loadMarketIndices({ logger })` — nạp chỉ số thị trường từ SSI iBoard, lọc mục thiếu `id`/`value` không hữu hạn; lỗi mạng/parse trả mảng rỗng, không ném ra.

### `packages/data-service/src/news/sentiment.js`
Chấm điểm cảm xúc tin tức tiếng Việt bằng từ điển từ khoá, **cố tình không dùng LLM** — tin về ba mươi mã mỗi ngày là hàng trăm lời gọi, trong khi hệ thống chỉ cần tín hiệu thô đủ để quyết định có đánh thức agent hay không; agent tự đọc tiêu đề trong context và tự đánh giá.

- `scoreSentiment(text)` — đếm từ khoá tiêu cực/tích cực, trả `(pos−neg)/(pos+neg)` trong khoảng -1..1; `0` nếu không khớp từ nào, `null` nếu văn bản rỗng.
- `decodeEntities(text)` — giải mã thực thể HTML (`&#243;`, `&amp;`...) — nguồn tin VN trả dạng `đ&#243;n` thay vì `đón`, không giải mã thì từ điển cảm xúc không khớp được từ có dấu.
- `detectSymbol(text, universeSymbols)` — dò mã bằng regex có biên từ (`\b`) để không khớp nhầm giữa chuỗi.

### `packages/data-service/src/lib/vn_time.js`
Tiện ích thời gian/ngày tháng theo giờ Việt Nam, dùng chung toàn data-service.

- `toVnDate(unixSeconds)` — epoch-giây sang `'YYYY-MM-DD'` theo giờ VN; validate khoảng hợp lệ để bắt ngay lỗi sai đơn vị (ví dụ truyền nhầm mili-giây).
- `nowVnDate(now)` — ngày hiện tại theo giờ VN.
- `isTradingDay(isoDate, holidays)` — Thứ Hai–Sáu VÀ không nằm trong `holidays` (đọc từ DB, không hardcode).
- `isTradingWindow(date, holidays)` — trong khung 09:20–11:30 và 13:00–14:30 giờ VN, và là ngày giao dịch.

---

# packages/agent-runtime

Mô phỏng giao dịch: dựng context cho LLM, gọi LLM, khớp lệnh theo luật VN, theo dõi vị thế, và vòng học tập.

### `packages/agent-runtime/src/agents/registry.js`
Nạp và validate danh sách định nghĩa agent từ `config/agents.json` — nguồn sự thật duy nhất cho 5 agent.

- `loadAgentDefs(path)` — đọc file JSON, ép kiểu mảng không rỗng, bắt buộc mỗi agent có đủ `id`/`name`/`provider`/`model`/`personaPrompt`/`initialCapital` — thiếu trường nào báo lỗi ngay lúc nạp.

### `packages/agent-runtime/src/agents/context.js`
Dựng gói context (JSON) gửi cho LLM trước mỗi lượt ra quyết định — TOÀN BỘ những gì agent "nhìn thấy".

- `fetchNews(repos)` (nội bộ) — MỘT câu truy vấn `repos.news.listRecent({ since: 3 ngày gần nhất, limit: 200 })` rồi nhóm ở client theo mã (tối đa 5 tin/mã) và tin chung thị trường (`symbol IS NULL`, tối đa 10 tin) — không query riêng từng mã vì tổng lượng tin một ngày chỉ vài chục bài. `repos.news` vắng mặt (test nhẹ) thì trả rỗng, không lỗi.
- `buildContext({ repos, agentId, tradeDate, universe, snapshots, priceMap, trigger, risk, queryVector })` — gộp: `market.indices` (chỉ số vĩ mô dùng chung cho mọi agent, từ `repos.market.getLatestIndices()`) và `market.news` (tin chung thị trường); `universe` kèm giá, chỉ báo, cờ `indicatorsMissing` tường minh (guardrails.js::checkBuy dùng cờ này để chặn mua khi thiếu dữ liệu), `maxAffordableQty` — TRẦN khối lượng còn mua được cho mã đó (đã trừ phí, làm tròn lô chẵn, tính sẵn thay vì để LLM tự chia availableCash/price — model nhỏ như Haiku 4.5 đã cho thấy tính sai gấp hàng chục-hàng trăm lần trong thực tế), `news` — tiêu đề/tóm tắt/sentiment/nguồn tin THẬT của riêng mã đó (không chỉ điểm sentiment: chấm điểm bằng từ điển chỉ đủ để watchdog biết có nên đánh thức agent hay không, còn bản thân agent phải tự đọc và tự đánh giá — trước đây context chưa từng đưa tin thật vào dù persona đã nói sẽ đọc "tin tức"), và `fundamentals` — chỉ số cơ bản quý gần nhất (P/E, P/B, ROE, ROA, cổ tức, nợ/vốn chủ, vốn hoá) đọc MỘT LẦN cho cả universe qua `repos.fundamentals.getLatestForSymbols` (giống cách gộp news), `null` nếu chưa ingest được cho mã đó — không đoán bừa; đây là mảng dữ liệu hệ thống thiếu hẳn từ đầu (không phải quên nối dây như news) cho tới khi được thêm; `portfolio` (tiền mặt, NAV, vị thế); `memory` (lệnh gần đây + bài học liên quan qua `retrieveLessons`); `constraints` (tỷ trọng tối đa/mã, lô tối thiểu, tiền khả dụng — không giới hạn số loại mã hay số lệnh mới/phiên, agent tự quyết định dàn trải). Mọi truy vấn đi qua repository có `assertAgentScope`, nên context của agent này không thể chứa dữ liệu của agent khác.

### `packages/agent-runtime/src/agents/runner.js`
Cầu nối giữa LLM và engine khớp lệnh: gọi provider, validate output, nộp từng quyết định hợp lệ cho engine.

- `DECISION_SCHEMA` — JSON Schema hình dạng quyết định LLM phải trả; `required` gồm cả `confidence` — ép mọi agent khai thang điểm chung.
- `createRunner({ repos, engine, provider, logger })` → `runOnce({ agentId, agentDef, context, ctx })` — provider LỖI thì agent **BỎ LƯỢT**, không fallback sang provider/model khác (đổi model giữa chừng sẽ phá hỏng việc so sánh 5 agent). Mỗi phần tử LLM trả về qua `validateDecision`; sai schema bị gom vào `invalid`, không làm hỏng quyết định hợp lệ khác. Quyết định hợp lệ được nộp tuần tự cho `engine.submit()`.

### `packages/agent-runtime/src/cli.js`
Entry point `npm run sim:session` — chạy tay MỘT phiên cho MỘT agent.

- Không export (script). Nạp agent def, dựng provider (thật hoặc `--stub`), gọi `runSession`, in kết quả JSON.

### `packages/agent-runtime/src/cli_all.js`
Entry point `npm run sim:all` — chạy TRỌN MỘT NGÀY cho TẤT CẢ agent, dùng chung một chuỗi tick đã ghi sẵn.

- Không export (script). Đọc tick trong ngày từ `quote_tick` MỘT LẦN, dùng CHUNG cho mọi agent (điều kiện so sánh công bằng: cùng dữ liệu, cùng thời điểm, chỉ khác model/chiến lược). Thiếu API key cho provider nào (không chạy `--stub`) thì báo lỗi và dừng, không chạy nửa vời. Chạy TUẦN TỰ (không song song) vì các agent dùng chung một connection pool. In bảng xếp hạng cuối cùng.

### `packages/agent-runtime/src/cli_day.js`
Entry point `npm run sim:day` — chạy trọn một ngày cho MỘT agent, in JSON ra stdout.

- Không export (script). Cùng cơ chế đọc tick và gọi `orchestrator.runDay` như `cli_all.js`, chỉ cho một `--agent`.

### `packages/agent-runtime/src/session.js`
Chạy TRỌN MỘT PHIÊN mô phỏng cho MỘT agent (Phase 2) — dựng giá, dựng context, gọi LLM một lần lúc mở cửa, khớp lệnh, chốt phiên. Được gọi bởi cả `cli.js` (chạy tay) lẫn `orchestrator/session.js` (bước OPEN của một ngày trọn vẹn).

- `runSession({ client, agentId, tradeDate, provider, agentDef, logger, priceOverride })` — quy đổi giá TradingView (nghìn đồng) sang VND đúng MỘT LẦN qua `buildPriceMaps`; `priceOverride` chỉ định giá tại thời điểm mở phiên (bắt buộc khi phát lại cả ngày, để không lấy nhầm tick mới nhất). Mở khoá các lô đã về tài khoản theo T+2 trước khi agent nhìn danh mục (`refreshSellable`). Dựng `context` qua `buildContext`, tính `indicatorsMissingSymbols` (Set các mã `indicatorsMissing = true` — lấy lại từ context vừa dựng, không tính lại từ đầu) truyền vào `ctx` cho `engine.submit`/`checkBuy` chặn mua trên mã thiếu chỉ báo. Gọi `runner.runOnce` với NAV/`dayPnl` thật. Chốt phiên bằng `closeSession`.
- `buildPriceMaps(client, universe)` (nội bộ) — giá tham chiếu = đóng cửa phiên gần nhất; giá khớp = tick gần nhất, chưa có thì dùng giá tham chiếu.
- `buildIndicatorMap(client, universe)` (nội bộ) — đọc snapshot chỉ báo mới nhất mỗi mã, bóc trường nội bộ `_raw`.

### `packages/agent-runtime/src/llm/decision_schema.js`
Hợp đồng quyết định của agent (spec §6.2) — đầu ra LLM PHẢI qua đây trước khi chạm engine.

- `DECISION_KEYS` — danh sách khoá hợp lệ của một quyết định.
- `validateDecision(raw)` — kiểm `action` thuộc BUY/SELL/HOLD, `symbol`/`reason` không rỗng, `confidence` BẮT BUỘC 0..1 (thang điểm chung — bỏ trống làm hỏng `confidenceCalibration`), BUY/SELL bắt buộc `quantity` nguyên dương + `orderType` hợp lệ + LIMIT có `limitPriceVnd`. Gom TẤT CẢ lỗi thay vì dừng ở lỗi đầu. Trả `{ ok, value }` hoặc `{ ok: false, errors }`.

### `packages/agent-runtime/src/llm/provider.js`
Factory chọn provider LLM theo tên — điểm nối duy nhất giữa cấu hình agent và các adapter cụ thể.

- `createProvider({ provider, model, apiKey, script, fetchImpl })` — `stub` tạo ngay không cần key; provider thật thiếu API key thì ném lỗi rõ ràng ngay lập tức, KHÔNG âm thầm fallback về stub (dự án bắt buộc LLM/dữ liệu phải THẬT).
- `availableProviders(env)` — liệt kê provider đã có key sẵn, chỉ dùng để báo cáo/kiểm tra trước khi chạy (`cli_all.js`), không dùng để tự động đổi provider.

### `packages/agent-runtime/src/llm/stub.js`
Provider tất định — chạy/test toàn bộ pipeline agent mà không cần API key, không cần mạng, không tốn token.

- `createStubProvider({ script })` — `complete()` phát lần lượt từng phần tử `script`; hết kịch bản thì lặp lại phần tử cuối; không truyền `script` thì dùng `HOLD` mặc định. Mỗi lần gọi trả bản `structuredClone` để không sửa nhầm vào kịch bản gốc.

### `packages/agent-runtime/src/llm/anthropic.js`
Adapter gọi thẳng Anthropic Messages API bằng `fetch`, không dùng SDK.

- `createAnthropicProvider({ apiKey, model, fetchImpl })` — ép Claude trả structured output bằng cơ chế tool-use (khai một tool giả `submit_decisions` với `jsonSchema` làm `input_schema`, bắt buộc `tool_choice` chọn đúng tool đó).

### `packages/agent-runtime/src/llm/openai.js`
Adapter gọi OpenAI Chat Completions API bằng function-calling để ép structured output.

- `createOpenAiProvider({ apiKey, model, fetchImpl, apiUrl })` — khai function `submit_decisions` với `parameters: jsonSchema`, ép `tool_choice` chọn đúng function, parse `tool_calls[0].function.arguments`. `apiUrl` tuỳ chỉnh được — điểm mà `deepseek.js` tái dùng để trỏ endpoint khác mà không chép lại logic.

### `packages/agent-runtime/src/llm/gemini.js`
Adapter gọi Google Gemini `generateContent` bằng `responseSchema` để ép JSON.

- `createGeminiProvider({ apiKey, model, fetchImpl, baseUrl })` — tách `system` vào trường `systemInstruction` riêng (Gemini không coi system là một vai trong hội thoại như Anthropic/OpenAI — gộp nhầm sẽ khiến persona bị hiểu lầm là lời người dùng); đổi role `assistant` → `model`; dùng `responseMimeType: application/json` + `responseSchema`.

### `packages/agent-runtime/src/llm/deepseek.js`
Adapter DeepSeek, tái dụng nguyên `openai.js` vì API tương thích OpenAI, chỉ khác endpoint.

- `createDeepSeekProvider({ apiKey, model, fetchImpl })` — bọc `createOpenAiProvider` với `apiUrl` trỏ DeepSeek, đổi tiền tố thông báo lỗi từ `openai:` thành `deepseek:` để log không gây hiểu nhầm.

### `packages/agent-runtime/src/memory/similarity.js`
Tìm kiếm ngữ nghĩa bằng cosine similarity tính thuần trong Node, không dùng pgvector.

- `cosine(a, b)` — cosine similarity giữa hai vector cùng độ dài; validate độ dài khớp và khác rỗng.
- `topK({ queryVector, items, k, minScore })` — xếp hạng bài học theo `similarity NHÂN confidence`, không chỉ độ giống: một bài học rất khớp ngữ cảnh nhưng đã bị scorer "phạt" (confidence thấp) không nên đứng trên bài học hơi kém khớp nhưng đã cứu nhiều lệnh. Bỏ qua pgvector vì ở quy mô vài trăm lesson mỗi agent, quét tuyến tính trong Node nhanh hơn chi phí vận hành thêm extension; muốn đổi chỉ cần thay hàm này.

### `packages/agent-runtime/src/memory/retrieval.js`
Lớp lấy bài học liên quan để nhồi vào prompt agent trước khi ra quyết định.

- `MAX_LESSONS_IN_PROMPT` (10) — số bài học tối đa đưa vào prompt.
- `retrieveLessons({ repos, agentId, queryVector, k })` — gọi `repos.lessons.listActive` (cô lập agent cưỡng chế ở tầng repository) rồi xếp hạng bằng `topK`. Chưa có `queryVector` (chưa có embedder) thì trả về danh sách xếp theo `confidence` — suy giảm êm, không phải hỏng.
- `buildQueryText({ symbol, sector, marketRegime, indicators })` — ghép các trường ngữ cảnh thành chuỗi text cho embedder; bỏ khoá bắt đầu `_` và giá trị không phải số hữu hạn.

### `packages/agent-runtime/src/learning/scorer.js`
Chấm điểm bài học — cơ chế chống tự đầu độc của vòng lặp học tập (spec §8.4).

- `RETIRE_BELOW` (0.3) / `MIN_RETRIEVALS_BEFORE_RETIRE` (10) — ngưỡng loại bỏ: chỉ "nghỉ hưu" khi confidence dưới 0.3 VÀ đã truy xuất ≥ 10 lần.
- `scoreLesson({ timesHelped, timesRetrieved })` — làm mượt Laplace `(helped+1)/(retrieved+2)` — một bài học mới trúng một lần không nhảy vọt lên 1.0; `(0,0)` cho đúng 0.5. Ném lỗi nếu `timesHelped > timesRetrieved` (bất biến logic).
- `shouldRetire({ confidence, timesRetrieved })` — áp hai ngưỡng trên.
- `outcomeHelped(pnl)` — chỉ lãi (`pnl > 0`) mới tính là "giúp"; hoà vốn/lỗ thì không.

### `packages/agent-runtime/src/learning/reflect.js`
Vòng tự rút bài học cuối phiên của từng agent (spec §8.3).

- `reflect({ repos, agentId, agentDef, provider, tradeDate, embedder, logger })` — lấy tối đa 50 lệnh gần nhất, gọi LLM tự phản tư trả về lesson mới. `provider` là model CHÍNH agent đó đang dùng — không dùng chung một model rút kinh nghiệm cho cả 5 agent (nếu không, 5 agent sẽ hội tụ về cùng một lối nghĩ). Lỗi gọi LLM không crash toàn phiên (`status: 'SKIPPED'`). Lesson hợp lệ được embed (nếu có embedder) rồi insert, sau đó gọi `pruneWeak` theo ngưỡng của `scorer.js`.
- `scoreLesson`, `shouldRetire`, `outcomeHelped` — re-export từ `scorer.js`.

### `packages/agent-runtime/src/sim/vn_rules.js`
Luật thị trường chứng khoán VN, hàm thuần — không DB, không LLM, không I/O.

- `PRICE_SCALE` — mặc định 1, vì TradingView trả giá cổ phiếu VN ĐÃ TÍNH SẴN BẰNG VND (kiểm chứng trên dữ liệu thật: FPT 67.000, HPG 21.800, VCB 14.400). Bản đầu Phase 2 từng giả định sai (đặt 1000), khiến mỗi cổ phiếu FPT bị tính thành 67 triệu đồng.
- `LOT_SIZE` (100) — lô chẵn giao dịch.
- `BAND_PCT` — biên độ dao động giá theo sàn: HOSE 7%, HNX 10%, UPCOM 15%.
- `toVnd(price)` — quy đổi giá thô sang VND theo `PRICE_SCALE`.
- `assertPlausibleVndPrice(vnd, context)` — chặn giá ngoài khoảng hợp lý (1.000–10.000.000 VND) — chính cơ chế đã bắt được lỗi `PRICE_SCALE` sai nói trên.
- `parseSymbol(symbol)` — tách `SAN:MA` thành `{ exchange, ticker }`.
- `tickSize(vnd)` — bước giá ba bậc theo mốc giá.
- `roundToTick(vnd)` — làm tròn một mức giá về bước giá gần nhất.
- `priceBand(refVnd, exchange)` — giá trần/sàn; nhân trước rồi mới chia để tránh sai số dấu phẩy động; làm tròn trần VÀO TRONG (xuống) và sàn VÀO TRONG (lên).
- `normalizeQty(qty)` — làm tròn số lượng xuống bội số `LOT_SIZE`.
- `settlementDate(tradeDate, holidays)` — ngày cổ phiếu về tài khoản theo T+2.5, đếm theo PHIÊN giao dịch thực (bỏ cuối tuần + ngày lễ).

### `packages/agent-runtime/src/sim/fees.js`
Phí giao dịch và thuế theo quy định VN, hàm thuần tính bằng VND.

- `FEE_RATE` (0.15%) — phí giao dịch, cả mua lẫn bán.
- `SELL_TAX_RATE` (0.1%) — thuế thu nhập cá nhân, chỉ khi bán.
- `buyCost({ priceVnd, qty })` — giá trị gốc, phí, tổng chi phí thực trả khi mua.
- `sellProceeds({ priceVnd, qty })` — giá trị gốc, phí, thuế, số tiền thực nhận khi bán.

### `packages/agent-runtime/src/sim/portfolio.js`
Xây dựng và cập nhật danh mục từ DB — tầng duy nhất biết T+2 tác động lên số lượng cổ phiếu bán được, qua mô hình từng lô mua (`position_lots`).

- `loadPortfolio({ repos, agentId, priceMap })` — thiếu giá thị trường thì dùng lại giá vốn làm giá hiện tại (unrealized P&L = 0%, không phải `NaN`); tính giá trị thị trường và NAV.
- `refreshSellable({ repos, agentId, today })` — cộng lại tổng `qty` các lô đã tới `sellableFrom <= today` để cập nhật `qtySellable` — mở khoá theo từng LÔ riêng biệt, đúng bản chất T+2 khi một mã được mua nhiều lần ở nhiều ngày.
- `applyBuy({ repos, agentId, symbol, qty, priceVnd, cost, tradeDate, exitPlan })` — cộng dồn vị thế, tính lại giá vốn bình quân gia quyền, tạo lô mới (`qtySellable` không tăng ngay), trừ tiền mặt.
- `applySell({ repos, agentId, symbol, qty, priceVnd, proceeds })` — gọi `consumeLots` TRƯỚC khi cập nhật vị thế (thứ tự bắt buộc — đổi ngược sẽ khiến lô và vị thế tạm thời không khớp); bán hết thì đóng vị thế; cộng tiền mặt.

### `packages/agent-runtime/src/sim/pnl.js`
Chốt phiên: mark-to-market toàn bộ danh mục, ghi snapshot NAV cuối ngày.

- `closeSession({ repos, agentId, tradeDate, priceMap })` — dựng danh mục qua `loadPortfolio`, so NAV với snapshot phiên TRƯỚC ĐÓ (không phải vốn ban đầu) để tính `dayPnl` — so với vốn ban đầu sẽ biến "lãi/lỗ trong ngày" thành "lãi/lỗ luỹ kế", khiến guardrail chặn-lỗ-ngày hiểu sai. Ghi snapshot mới, trả `cash/marketValue/nav/dayPnl/totalReturnPct`.

### `packages/agent-runtime/src/sim/engine.js`
Trọng tài của hệ thống (spec §3.3) — agent chỉ ĐỀ XUẤT, engine kiểm luật thị trường và hàng rào rủi ro rồi mới cho khớp.

- `SLIPPAGE_PCT` (0.1%) — trượt giá; MARKET luôn trượt bất lợi cho người đặt lệnh.
- `createEngine({ repos, logger, slippagePct })` → `{ submit, matchPending }`:
  - `submit(agentId, decision, ctx)` — HOLD không ghi gì vào `orders`; parse sàn, validate giá hợp lý (`assertPlausibleVndPrice`), chuẩn hoá số lượng về bội lô chẵn; ghi order TRƯỚC khi kiểm tra (lệnh bị từ chối vẫn có dấu vết học được); kiểm `checkDailyLoss` → biên độ giá LIMIT → `checkBuy`/`checkSell`.
  - `matchPending(agentId, ctx)` — đối chiếu lệnh LIMIT treo với tick mới, khớp nếu giá đã chạm ngưỡng.
  - `settleFill` (nội bộ) — ghi fill, cập nhật vị thế, ghi `trades`.

### `packages/agent-runtime/src/sim/guardrails.js`
Hàng rào cứng, NGOÀI tầm với của LLM (spec §7.2, §3.3) — hàm thuần, không bao giờ ném lỗi, luôn trả `{ ok, reason }`.

- `DEFAULT_RISK` — tối đa 20% NAV một mã, dừng giao dịch khi lỗ ngày vượt 5% NAV. Không giới hạn số loại mã đang giữ.
- `checkBuy({ symbol, costVnd, cash, nav, positions, risk, indicatorsMissing })` — chặn NGAY nếu `indicatorsMissing = true` (cùng triết lý với `DATA_STALE` chặn cả phiên, thu hẹp xuống một mã); không đòn bẩy; chặn vượt tỷ trọng một mã. Không giới hạn số vị thế — agent tự quyết định dàn trải bao nhiêu mã.
- `checkSell({ symbol, qty, positions })` — chặn bán mã không có vị thế, hoặc vượt `qtySellable` (T+2) — không bán khống.
- `checkDailyLoss({ dayPnl, nav, risk })` — chặn toàn bộ giao dịch còn lại khi lỗ ngày vượt ngưỡng.

### `packages/agent-runtime/src/sim/metrics.js`
Chỉ số so sánh hiệu năng agent (spec §10), tính từ `trade_outcomes` và `portfolio_snapshot`.

- `winRate(outcomes)` — tỷ lệ vòng có lãi; `null` (không phải 0) khi chưa có vòng nào.
- `sharpe(dailyReturns)` — Sharpe niên hoá, độ lệch chuẩn MẪU (chia n−1 — chia n sẽ thổi phồng Sharpe khi ít phiên); `null` khi độ lệch bằng 0 hoặc chưa đủ 2 quan sát.
- `maxDrawdown(navSeries)` — sụt sâu nhất từ ĐỈNH, số dương theo %.
- `avgHoldingDays(outcomes)` — số ngày giữ trung bình mỗi vòng.
- `confidenceCalibration(outcomes)` — chênh lệch confidence trung bình giữa vòng THẮNG và vòng THUA (đo hiệu chuẩn, không phải độ chính xác); dương = agent tự tin đúng lúc; âm = dấu hiệu overconfidence; `null` khi chưa đủ cả hai loại vòng.
- `lessonHitRate(lessons)` — tỷ lệ bài học thực sự giúp được trên tổng lần truy xuất.
- `dailyReturns(navSeries)` — chuỗi lợi suất ngày từ chuỗi NAV.
- `computeAndSaveMetrics({ repos, agentId, tradeDate })` — gom toàn bộ chỉ số trên và lưu (idempotent).

### `packages/agent-runtime/src/sim/outcomes.js`
Ghép lệnh MUA với lệnh BÁN thành vòng trọn vẹn (round-trip) theo FIFO.

- `matchSell({ sell, openBuys })` — ghép một lệnh BÁN với các lệnh MUA CŨ TRƯỚC (FIFO, khớp cách `consumeLots` tiêu lô); PnL tính TRÊN TIỀN THỰC (giá mua cộng phí, giá bán trừ phí và thuế). Bán nhiều hơn đã mua thì ném lỗi thay vì âm thầm bỏ qua.
- `recordOutcomes({ repos, agentId, logger })` — quét lịch sử lệnh, ghi các vòng CHƯA từng ghi (idempotent).

### `packages/agent-runtime/src/orchestrator/events.js`
Bảng tên sự kiện phát qua `event_log` — hợp đồng giữa agent-runtime và dashboard.

- `EVENTS` — `SESSION_STATE`, `AGENT_STARTED`, `AGENT_DECIDED`, `AGENT_SKIPPED`, `ORDER_PLACED`, `ORDER_FILLED`, `ORDER_REJECTED`, `TRIGGER_FIRED`, `POSITION_MARKED`, `METRICS_UPDATED`, `MARKET_SNAPSHOT`.

### `packages/agent-runtime/src/orchestrator/triggers.js`
Đánh giá điều kiện thoát/cảnh báo — toàn bộ hàm thuần, chạy hàng chục lần/ngày cho mỗi vị thế/mã.

- `TRIGGER_TYPES` — `TAKE_PROFIT`, `STOP_LOSS`, `TRAILING`, `TIME_STOP`, `NEWS_ALERT`, `EOD_REVIEW`.
- `DEBOUNCE_MINUTES` (30) — chống rung cho cùng loại trigger trên cùng mã.
- `evaluateTriggers({ position, lastPriceVnd, now, heldDays, newsSentiment })` — `TRAILING` đo từ ĐỈNH kể từ lúc mua (không phải giá vốn); `NEWS_ALERT` nổ khi sentiment ≤ -0.5; `EOD_REVIEW` (từ 14:30 giờ VN) chỉ áp dụng cho vị thế CÓ khai `exitPlan`.
- `isDebounced({ lastFiredAt, now, minutes })` — so khoảng cách với lần nổ gần nhất.
- `UNIVERSE_MOVE_THRESHOLD_PCT` (5%) — ngưỡng biến động đáng chú ý cho mã CHƯA giữ.
- `evaluateUniverseAlerts({ symbols, tickPriceMap, refPriceMap, newsSentimentMap, moveThresholdPct })` — Alert Center: rà mã KHÔNG nằm trong vị thế đang giữ, nổ `PRICE_MOVE` khi lệch ≥ ngưỡng so tham chiếu, nổ `NEWS_ALERT` khi tin rất xấu dù giá đứng yên. Watchdog chỉ GHI lại, không tự đánh thức agent để cân nhắc mua (thiếu ngữ cảnh sizing/chỉ báo để không mua mù).

### `packages/agent-runtime/src/orchestrator/watchdog.js`
Vòng theo dõi mỗi tick — bất biến quan trọng nhất: không trigger nào nổ thì KHÔNG lời gọi LLM nào phát ra.

- `MECHANICAL_SELL_TRIGGERS` (`STOP_LOSS`, `TRAILING`) — hai trigger BẢO VỆ VỐN bán thẳng qua engine, không hỏi lại LLM: chậm một nhịp hỏi ý kiến đúng lúc giá đang rơi là mất thêm tiền thật. `TAKE_PROFIT`/`TIME_STOP`/`NEWS_ALERT`/`EOD_REVIEW` vẫn đánh thức agent — đó là những lúc có thể đáng cân nhắc tiếp, quyết định thuộc về agent.
- `autoSellPosition(...)` (nội bộ) — đặt lệnh SELL thị trường thẳng qua `engine.submit`, đúng số lượng `qtySellable` (không phải cả vị thế — phần chưa qua T+2.5 có muốn cũng không bán được); 0 cổ phiếu bán được thì trả `REJECTED` ngay, khỏi tốn một lượt `engine.submit()` chắc chắn bị `checkSell` chặn.
- `createWatchdog({ repos, engine, runner, logger })` → `tick({ agentId, agentDef, now, tradeDate, tickPriceMap, refPriceMap, newsSentimentMap, universe })`:
  - Vị thế đang giữ: cập nhật đỉnh giá (chỉ đi lên), gọi `evaluateTriggers`, kiểm debounce trước khi ghi `trigger_log` + phát `trigger.fired`. `STOP_LOSS`/`TRAILING` bán máy móc ngay (`autoSellPosition`); bán thành công thì dọn mã đó khỏi hàng chờ đánh thức LLM (`TAKE_PROFIT` có thể đã đưa vào trước đó — không hỏi LLM về một vị thế vừa đóng); bán KHÔNG được (chưa qua T+2.5) thì vẫn đánh thức LLM như đường cũ.
  - Mã KHÔNG giữ (từ `universe` trừ các mã đang giữ): gọi `evaluateUniverseAlerts`, chỉ ghi sự kiện, không đánh thức.
  - Mọi trigger còn lại (không bị bán máy móc) nổ trong CÙNG tick gộp thành MỘT lời gọi LLM duy nhất, mang NAV/`dayPnl` THẬT (không phải 0 — guardrail chặn-lỗ-ngày đọc chúng), kèm `positions` (qtyTotal/qtySellable/avgCostVnd của đúng các mã vừa đánh thức — thiếu phần này từng khiến LLM trả `quantity: undefined` vì không biết đang giữ bao nhiêu) và `news` (tin THẬT theo mã, không chỉ điểm sentiment — `NEWS_ALERT` nổ vì có tin xấu nhưng trước đây agent không được đọc tin đó viết gì). Provider lỗi không làm sập watchdog.
- `heldDaysOf(openedAt, now)` (nội bộ) — số ngày đã giữ, dùng cho `TIME_STOP`.

### `packages/agent-runtime/src/orchestrator/session.js`
Máy trạng thái điều phối TRỌN MỘT NGÀY cho một agent (Phase 3): `PRE_OPEN → OPEN → WATCHING → CLOSING → LEARNING → IDLE`.

- `SESSION_STATES` — sáu trạng thái hợp lệ.
- `createOrchestrator({ client, logger })` → `runDay({ agentId, agentDef, tradeDate, provider, ticks, embedder })`:
  - **PRE_OPEN** — đọc `session_state`; không phải `DATA_READY`/`DATA_PARTIAL` thì KHÔNG mở phiên. Đọc `getLatestIndices()` và phát `market.snapshot` (nếu có dữ liệu) — cùng bối cảnh đẩy vào prompt agent, cho người vận hành thấy như agent thấy.
  - **OPEN** — gọi `runSession` với giá tick ĐẦU NGÀY (không phải mới nhất).
  - **WATCHING** — lặp qua tick, gọi `watchdog.tick()` cho cả vị thế lẫn universe alert; `newsSentimentMap` là sentiment TỆ NHẤT 24h.
  - **CLOSING** — mark-to-market bằng giá cuối cùng thấy được.
  - **LEARNING** — theo thứ tự: ghép vòng (`recordOutcomes`) → chấm điểm bài học (`applyOutcome`) → tính metric (`computeAndSaveMetrics`) → rút bài học mới (`reflect`).
- `mapToVnd` / `buildRefPriceMap` / `buildTickPriceMap` (nội bộ) — quy đổi giá và dựng price map.

---

# packages/api

Dashboard realtime — **chỉ đọc**, cưỡng chế ở tầng database bằng role riêng.

### `packages/api/src/server.js`
Dựng và khởi động HTTP server: nối repository chỉ-đọc, đăng ký route, gác cổng token và phương thức, phát sự kiện realtime qua SSE.

- `createServer({ config, logger })` — mở DB bằng `config.readonlyUrl` (role chỉ SELECT); gắn route GET (và đúng một PATCH `agents/:id/config`) qua `createRouter`; chặn method khác bằng 405; kiểm token qua `?token=`/header nếu `config.token` được cấu hình; phục vụ SSE tại `/api/stream`; phục vụ file tĩnh qua `serveStatic`; lắng nghe NOTIFY Postgres rồi đọc lại bản ghi đầy đủ từ `event_log` để broadcast.
- `listen()` — khởi động listener NOTIFY TRƯỚC rồi mới mở cổng HTTP, để không lọt sự kiện phát sinh lúc khởi động.
- `close()` — tắt SSE hub, dừng listener, đóng HTTP server rồi đóng pool DB, đúng thứ tự để không rò rỉ handle.

### `packages/api/src/router.js`
Bảng tra route HTTP tối giản tự viết tay, không dùng framework.

- `createRouter()` → `{ get, patch, resolve }`; `resolve(pathname, method)` tìm route khớp bằng so số segment rồi so từng segment tĩnh, ưu tiên route ÍT tham số động hơn khớp trước, trả `params` đã decode.

### `packages/api/src/config.js`
Đọc cấu hình khởi động API server, ép ràng buộc an toàn ngay lúc load.

- `loadApiConfig(env)` — bắt buộc `DATABASE_URL_READONLY`; đọc `DASHBOARD_HOST` (mặc định `127.0.0.1`) và `DASHBOARD_TOKEN`; host ra ngoài localhost mà token rỗng thì **ném lỗi ngay khi load config, chặn cả khởi động** — mở cổng ra mạng không token nghĩa là bất kỳ ai cũng đọc được toàn bộ lịch sử giao dịch.

### `packages/api/src/static.js`
Phục vụ file tĩnh dashboard (`apps/public`) không cần thư viện ngoài.

- `serveStatic(rootDir, urlPath)` — decode URL TRƯỚC khi kiểm tra để chặn path traversal dạng encode (`%2e%2e%2f`), xác nhận đường dẫn cuối còn nằm trong `rootDir` sau khi `..` đã giải quyết; 403 nếu thoát thư mục, 404 nếu không tìm thấy.

### `packages/api/src/routes.js`
Toàn bộ logic nghiệp vụ của dashboard API — mỗi hàm ứng một endpoint.

- `HttpError` — lỗi HTTP có `status`.
- `createRoutes({ client, repos, agentsConfigPath, modelCatalogPath })` → object handler:
  - `session({ query })` — trạng thái dữ liệu một ngày; không có dữ liệu trả thẳng `'UNKNOWN'` (trả `DATA_READY` giả cho ngày chưa ingest là đúng loại nói dối cả hệ thống tránh).
  - `leaderboard()` — bảng xếp hạng, JOIN LATERAL snapshot mới nhất mỗi agent; cờ `isPending` khi `config/agents.json` khác DB đang chạy thật.
  - `agent` / `positions` / `decisions` / `lessons` ({ params }) — chi tiết một agent.
  - `history({ params, query })` — chuỗi NAV theo ngày (bỏ mốc 1970) kèm `metrics_daily` mới nhất (gồm `confidenceCalibration`).
  - `events({ query })` — sự kiện theo `since`/`limit`.
  - `modelCatalog()` — đọc `config/model-catalog.json`.
  - `agentConfig({ params })` — provider/model ĐANG CHỜ ÁP DỤNG (file) bên cạnh ĐANG CHẠY THẬT (DB) — hai nguồn cố ý lệch để form tô đúng lần sửa gần nhất.
  - `updateAgentConfig({ params, body })` — sửa provider/model, CHỈ ghi `config/agents.json` (không đụng DB); validate qua model catalog; ghi file tạm rồi `rename` đè.
  - `updateAgentRisk({ params, body })` — sửa `maxPositionPctNav`/`dailyLossLimitPct` trong `riskConfig`, cùng con đường ghi an toàn (chỉ `config/agents.json`); chỉ ghi đè field THỰC SỰ được truyền, không xoá field còn lại; validate khoảng (0, 100]. Dùng cho agent điều phối qua Telegram.

### `packages/api/src/coordinator.js`
"Bộ não" của agent điều phối qua Telegram — chỉ đọc dữ liệu thật, mọi thay đổi đi qua đúng con đường ghi đã có (`config/agents.json`), không tự đặt lệnh mua/bán, không sửa persona.

- `COORDINATOR_SCHEMA` — JSON Schema `{ reply, action }`; `action.type` là `NONE`/`SET_MODEL`/`SET_RISK` — dùng object có `type: 'NONE'` thay vì `null` để tránh vấn đề nullable-type không nhất quán giữa các provider.
- `SYSTEM_PROMPT` — nói rõ ranh giới: chỉ dùng dữ liệu được cung cấp, không bịa; chỉ được SET_MODEL/SET_RISK; không được tự giao dịch hay đổi persona.
- `buildSnapshot({ routes })` — gộp `session`, `leaderboard`, `events` (30 gần nhất), và với MỖI agent: `positions` + 10 quyết định gần nhất — gom đủ một lần vì không có tool-calling nhiều bước, và với chỉ 5 agent kích thước này vẫn nhỏ.
- `respond({ provider, message, history, snapshot })` — gọi `provider.complete()` (tái dùng nguyên adapter LLM của agent-runtime); bóc phần tử đầu nếu trả về mảng (cùng hình dạng `complete()` dùng cho agent giao dịch); báo lỗi rõ nếu thiếu `reply`; mặc định `action = NONE` nếu provider bỏ trống.
- `applyAction({ routes, action })` — KHÔNG BAO GIỜ ném lỗi ra ngoài, luôn trả một dòng tiếng Việt (thành công hay lý do thất bại) để nối vào reply; `SET_MODEL`/`SET_RISK` gọi thẳng `routes.updateAgentConfig`/`updateAgentRisk`.

### `packages/api/src/telegram_poll.js`
Long-polling Telegram (`getUpdates`) — không dùng webhook, vì máy chạy hệ thống không có địa chỉ HTTPS công khai cố định để Telegram gọi ngược vào.

- `createTelegramPoll({ token, allowedChatId, onMessage, fetchImpl, logger, timeoutSec, retryDelayMs })` → `{ start, stop, pollOnce, getOffset }`:
  - `pollOnce()` — gọi `getUpdates`, đẩy `offset` qua `update_id` lớn nhất TRƯỚC khi xử lý (một tin lỗi không được làm cả vòng polling kẹt lặp lại đúng tin đó); chỉ gọi `onMessage` cho tin từ đúng `allowedChatId` (so sánh ép về string vì Telegram trả `chat.id` dạng số nhưng cấu hình có thể là string) — chat khác bị bỏ qua và log cảnh báo; lỗi trong `onMessage` của một tin không chặn các tin còn lại cùng batch.
  - `start()` — lặp gọi `pollOnce()` vô hạn tới khi `stop()`; lỗi polling (mất mạng, HTTP lỗi) thì chờ `retryDelayMs` rồi thử lại, không dừng hẳn.

### `packages/api/src/telegram_bot.js`
Entry point `npm run telegram-bot` — nối `coordinator.js` với `telegram_poll.js` thành agent điều phối chạy thật.

- Không export (script). Kết nối DB bằng `DATABASE_URL_READONLY` (role chỉ SELECT — giống dashboard, một lỗi/lỗ hổng ở đây vẫn không sửa được DB); dựng `routes` (tái dùng `createRoutes` của dashboard) và `provider` (tái dùng `createProvider` của agent-runtime, mặc định `anthropic`/`claude-sonnet-5` qua `COORDINATOR_PROVIDER`/`COORDINATOR_MODEL`). Giữ lịch sử hội thoại trong bộ nhớ (tối đa 10 cặp hỏi-đáp gần nhất, mất khi restart — chấp nhận được cho v1). Mỗi tin nhắn: `buildSnapshot` → `respond` → `applyAction` → gửi `reply` (kèm kết quả action nếu có) qua `createTelegramReporter().send()` (tái dùng reporter đã có).

### `packages/api/src/stream/listener.js`
Lắng nghe NOTIFY Postgres trên kênh `agent_events`.

- `createEventListener({ connectionString, onEnvelope, logger })` → `{ start, stop }` — dùng `pg.Client` RIÊNG (không lấy từ pool) vì `LISTEN` gắn với MỘT connection cụ thể; tự thử kết nối lại sau 2 giây nếu mất kết nối.

### `packages/api/src/stream/sse.js`
Quản lý client SSE cho dashboard realtime.

- `createSseHub({ eventsRepo, heartbeatMs, maxClients })` → `{ attach, broadcast, clientCount, stop }`:
  - `attach(res, lastEventId)` — 503 nếu đạt `maxClients`; phát lại lịch sử BỊ LỠ TRƯỚC khi coi như đã nối vào luồng trực tiếp (không có khoảng trống giữa lịch sử và realtime).
  - `broadcast(event)` — gửi một sự kiện tới mọi client đang mở.
  - Heartbeat định kỳ để proxy không cắt kết nối vì tưởng đã chết.

### `packages/api/src/cli_report.js`
Script chạy tay/cron cuối phiên: đọc bảng xếp hạng, in console, gửi Telegram.

- Không export (entrypoint CLI). Mở DB bằng `DATABASE_URL` (không phải role readonly — job nội bộ, khác dashboard công khai); gọi `createTelegramReporter().reportDay()`; LUÔN in bảng xếp hạng ra console dù Telegram thành công hay không.

### `packages/api/src/reporters/telegram.js`
Định dạng và gửi bản tin tổng kết phiên qua Telegram Bot API — chỉ đọc dữ liệu đã có từ `routes.leaderboard`.

- `formatLeaderboard({ tradeDate, agents })` — dựng Markdown Telegram: ▲/▼/· theo dấu `totalReturnPct`, NAV kiểu số VN, dòng "chênh lệch dẫn đầu" khi ≥ 2 agent.
- `createTelegramReporter({ token, chatId, fetchImpl, logger })` → `{ send, reportDay, enabled }`; `enabled = false` khi thiếu `token`/`chatId` — `send()` tự tắt, không gọi mạng. Mọi lỗi mạng/HTTP trả `{ sent: false, reason }` thay vì ném — Telegram chết không được làm hỏng job báo cáo cuối phiên.

### `packages/api/public/app.js`
Frontend dashboard — thuần JS, không framework, không build step.

- `refreshSession()` — tag trạng thái dữ liệu và độ tươi.
- `renderBoard(agents)` / `refreshBoard()` — bảng xếp hạng; nháy ô NAV khi đổi.
- `renderPositions(list)` — thanh vị thế với vạch cắt lỗ/chốt lời.
- `renderNavChart({ series, initialCapital, metrics })` — SVG nội tuyến cho đường NAV; trục dọc LUÔN bao cả vốn ban đầu.
- `renderNavMetrics(m, latestNav, initialCapital)` — bảng chỉ số: NAV, lãi/lỗ, sụt sâu nhất, tỷ lệ thắng, Sharpe, số vòng, Hiệu chuẩn tin cậy.
- `renderDecisions(list)` — lịch sử quyết định gần đây.
- `describe(e)` / `pushEvent(e)` — diễn giải một sự kiện thành dòng chữ, đẩy vào feed (giới hạn `MAX_FEED_ITEMS` = 200).
- `openStream()` — mở `EventSource`, đăng ký riêng từng loại sự kiện; một số loại kích hoạt làm mới bảng.
- `openConfigForm()` / `submitConfigForm(e)` / `fillModelOptions()` — form sửa provider/model, tô theo giá trị ĐANG CHỜ ÁP DỤNG.
