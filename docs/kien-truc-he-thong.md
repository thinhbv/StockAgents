# Kiến trúc hệ thống

Tài liệu này mô tả **4 package** tạo nên StockAgents, luồng dữ liệu giữa
chúng, và vai trò của từng module bên trong. Đọc cùng với
[Thiết kế database](thiet-ke-database.md) (các bảng) và
[Hướng dẫn sử dụng](huong-dan-su-dung.md) (cách chạy).

## Tổng quan

```
 TradingView Desktop           6 nguồn tin VN
 (CDP :9222)                         │
       │  broker.js                  │
       │  (điểm chạm DUY NHẤT)        │
       ▼                              ▼
 ┌─────────────────────────────────────────┐        node-cron
 │   packages/data-service                  │◄── scheduler.js điều phối lịch
 │   thu thập giá + tin tức                 │
 └───────────────────┬───────────────────────┘
                      │ ghi
                      ▼
              ┌───────────────┐
              │  PostgreSQL   │
              └───────┬───────┘
        đọc + ghi (role có quyền ghi) │
                      ▼
 ┌─────────────────────────────────────────┐   spawn tiến trình con
 │   packages/agent-runtime                 │◄── (từ data-service, không import)
 │   agent quyết định & khớp lệnh           │
 └──────────┬───────────────────┬──────────┘
            │ gọi LLM           │ ghi
            ▼                   ▼
 Anthropic / OpenAI /     ┌───────────────┐
 Gemini / DeepSeek        │  PostgreSQL   │
                          └───────┬───────┘
              đọc CHỈ-ĐỌC (role stockagents_ro) │
                                  ▼
                     ┌─────────────────────────┐
                     │   packages/api          │
                     │   dashboard + báo cáo    │
                     └──────┬──────────┬───────┘
                   SSE realtime     cuối phiên
                            ▼              ▼
                     Trình duyệt      Telegram
```

**4 package, 4 vòng đời riêng, chỉ nói chuyện qua PostgreSQL** (trừ
`data-service` → `agent-runtime`, vốn đi qua tiến trình con `npm run`, không
`import` trực tiếp — xem [Ranh giới kiến trúc](#ranh-giới-kiến-trúc) bên dưới).

| Package | Vai trò một câu | Vòng đời |
|---|---|---|
| `db` | Schema + tầng truy cập dữ liệu dùng chung | Thư viện, không tự chạy |
| `data-service` | Thu thập giá/tin tức, giữ lịch cron | Tiến trình nền dài hạn |
| `agent-runtime` | 5 agent quyết định, khớp lệnh, học | CLI chạy theo yêu cầu/cron |
| `api` | Dashboard realtime + báo cáo Telegram | Server HTTP dài hạn |

---

## 1. `packages/db` — schema và tầng truy cập dữ liệu

Không ai được viết SQL tay ở package khác — mọi truy vấn đi qua đây.

| File | Vai trò |
|---|---|
| `client.js` | Bọc `pg.Pool`, đăng ký type parser (giữ `NUMERIC` dạng chuỗi cho tiền tệ, ép `DATE` về chuỗi `YYYY-MM-DD` tránh lệch múi giờ) |
| `config.js` | Đọc `.env`, báo lỗi rõ tên biến thiếu thay vì crash mơ hồ |
| `migrate.js` | Chạy migration theo thứ tự, tự bỏ qua cái đã áp dụng (bảng `schema_migrations`) |
| `repositories/_guard.js` | `assertAgentScope()` — mọi hàm chạm bảng có `agent_id` phải gọi hàm này trước; cô lập giữa 5 agent cưỡng chế bằng code, không phải quy ước |
| `repositories/agents.js` | CRUD `agents`, tiền mặt (`cash_vnd`), `portfolio_snapshot`, `metrics_daily` |
| `repositories/trading.js` | `orders`/`fills`/`positions`/`position_lots`/`trades`/`trade_outcomes` |
| `repositories/market.js` | `ohlcv_daily`/`quote_tick`/`indicator_snapshot`/`market_index_snapshot` — kể cả hàm `getLatestPrices` mà dashboard dùng để tính lãi/lỗ tạm tính |
| `repositories/universe.js` | Danh sách mã theo dõi |
| `repositories/ops.js` | `session_state` (cổng DATA_READY/PARTIAL/STALE), `ingest_errors`, `market_holidays` |
| `repositories/events.js` | Ghi `event_log` **và** phát `pg_notify` trong cùng một câu lệnh — nguyên tử, dashboard SSE không bao giờ thấy sự kiện mà không được báo |
| `repositories/triggers.js` | `trigger_log` — chống rung watchdog |
| `repositories/lessons.js` | `lessons`/`lesson_usage` — trí nhớ dài hạn của agent |
| `repositories/news.js` | `news_items` — không có `assertAgentScope` vì tin tức không thuộc về agent nào |

---

## 2. `packages/data-service` — thu thập dữ liệu, giữ lịch

**Chỉ biết dữ liệu, không biết agent nào đang giao dịch** — ranh giới cố ý,
xem mục Ranh giới bên dưới.

### Lõi

| File | Vai trò |
|---|---|
| `index.js` | Entry point tiến trình nền: nối DB, dựng broker, đăng ký job vào scheduler, xử lý shutdown êm (`drain()` chờ job dở dang trước khi đóng pool) |
| `scheduler.js` | `SCHEDULES` (khai báo cron) + `startScheduler()` — mỗi job lỗi bị nuốt và ghi log, không làm sập tiến trình |
| `cli.js` | Chạy một job đơn lẻ bằng tay (`ingest-prices`, `poll-quotes`) |

### `cdp/` — cầu nối TradingView Desktop

| File | Vai trò |
|---|---|
| `broker.js` | **Điểm chạm DUY NHẤT** tới TradingView. Mutex promise-chain tuần tự hoá mọi lệnh (chart chỉ có 1, hai lệnh song song sẽ đọc nhầm dữ liệu của nhau). `waitForSymbol()` tự viết thay hàm mặc định của `tradingview-mcp` vì hàm gốc đọc tên chỉ báo thay vì tên mã sau khi đã gắn RSI lên chart |
| `studies.js` | Danh sách 4 chỉ báo bắt buộc gắn lên chart, kèm tham số đã kiểm chứng khớp chu kỳ chuẩn (vd MA phải truyền `length:20`, mặc định TradingView là 9) |

### `collectors/` — hàm thuần, biến dữ liệu CDP thô thành hình dạng DB cần

| File | Vai trò |
|---|---|
| `prices.js` | Lấy OHLCV từ chart, chuẩn hoá ngày theo giờ VN |
| `quotes.js` | Lấy giá tick, **tự đối chiếu** `q.symbol` với mã yêu cầu (chart chưa chuyển kịp thì báo lỗi thay vì âm thầm trả giá mã cũ), và loại tick khi ≥2 mã trong cùng lượt ra cùng một giá (dấu hiệu CDP đọc dính giá cũ) |
| `indicators_calc.js` | **Tự tính** RSI/MACD/Bollinger/ATR từ `ohlcv_daily` — không đọc trực tiếp từ TradingView vì Data Window chỉ điền khi có người ngồi trước máy |
| `indicators.js` | Parse giá trị dạng chuỗi từ `getStudyValues()` sang số (đường vòng khi không tự tính được) |

### `jobs/` — mỗi job là một hàm thuần nhận `{ broker, repos }`, test được không cần CDP thật

| File | Vai trò |
|---|---|
| `ingest_prices.js` | 08:30 — OHLCV 60 phiên + chỉ báo cho toàn universe, cập nhật `session_state` |
| `poll_quotes.js` | 09:00–14:30 mỗi 5 phút — giá tick trong phiên, tự bỏ qua ngoài giờ/nghỉ trưa/lễ |
| `ingest_news.js` | 08:45 — gom tin từ `news/sources.js`, chấm sentiment, gắn mã |
| `prune_events.js` | 02:00 — dọn `event_log` cũ hơn `EVENT_LOG_RETENTION_DAYS` |

### `news/` và `lib/`

| File | Vai trò |
|---|---|
| `news/sources.js` | Nối 7 nguồn tin VN có sẵn trong `tradingview_mcp/news/sources/` — điểm chạm duy nhất tới các module đó |
| `news/sentiment.js` | Chấm điểm bằng **từ điển**, không LLM — chỉ cần đủ tín hiệu thô để quyết định có đánh thức agent hay không |
| `lib/vn_time.js` | Giờ giao dịch VN (09:20–11:30, 13:00–14:30), ngày nghỉ lễ, chuyển epoch↔ngày |

---

## 3. `packages/agent-runtime` — nơi agent quyết định

### CLI (điểm vào)

| File | Dùng khi |
|---|---|
| `cli.js` | Mở phiên cho 1 agent, không watchdog (`sim:session`) |
| `cli_day.js` | Replay trọn 1 ngày cho 1 agent — nạp sẵn tick, chạy 1 lượt (`sim:day`) |
| `cli_all.js` | Như trên, cả 5 agent trên cùng chuỗi tick (`sim:all`) — công bằng vì mọi agent thấy đúng cùng dữ liệu |
| `cli_watch.js` | **Watcher sống** — `--mode tick` mở phiên (nếu chưa) + watchdog 1 tick; `--mode close` chốt sổ. `data-service` gọi lại mỗi 5 phút, không nạp sẵn cả ngày |

### `orchestrator/` — máy trạng thái điều phối 1 agent qua 1 ngày

| File | Vai trò |
|---|---|
| `session.js` | `createOrchestrator()` — `openDay` (PRE_OPEN+OPEN), `buildWatchContext`, `closeDay` (CLOSING+LEARNING), `runDay` (ghép cả 3 cho replay theo lô), `hasOpenedToday`/`hasClosedToday` (watcher sống dựa vào để không mở/chốt trùng) |
| `watchdog.js` | Vòng theo dõi mỗi tick. **Bất biến:** không trigger nào nổ thì không gọi LLM. `STOP_LOSS`/`TRAILING` bán thẳng qua `engine.submit()`; các trigger còn lại đánh thức LLM |
| `triggers.js` | Hàm thuần `evaluateTriggers()` — 6 điều kiện đánh thức, và `isDebounced()` chống rung 30 phút |
| `events.js` | Hằng số tên sự kiện — hợp đồng giữa nơi ghi và dashboard SSE đọc |

### `agents/` — cầu nối giữa dữ liệu và LLM

| File | Vai trò |
|---|---|
| `registry.js` | Nạp + kiểm tra `config/agents.json` |
| `context.js` | Dựng prompt: danh mục, chỉ báo, tin tức, bài học cũ, và `maxAffordableQty` — TRẦN khối lượng tính sẵn vì model nhỏ (Haiku) từng tính sai gấp hàng chục lần |
| `runner.js` | Gọi LLM, validate qua `decision_schema.js`, đẩy quyết định hợp lệ vào `engine.submit()` |

### `llm/` — một adapter cho mỗi nhà cung cấp

| File | Vai trò |
|---|---|
| `provider.js` | Factory chọn adapter theo tên, báo thiếu API key rõ ràng |
| `decision_schema.js` | **Cổng duy nhất** mọi output LLM phải qua trước khi chạm engine — ép kiểu, ép dấu `exitPlan` (`stopLossPct` luôn âm, `takeProfitPct`/`trailingPct` luôn dương) bất kể agent trả dấu gì |
| `stub.js` | Provider tất định — chạy/test không cần key, không tốn token |
| `anthropic.js` / `openai.js` / `gemini.js` / `deepseek.js` | Adapter thật cho từng nhà cung cấp |

### `sim/` — luật thị trường và trọng tài khớp lệnh, toàn HÀM THUẦN

| File | Vai trò |
|---|---|
| `vn_rules.js` | `PRICE_SCALE`, lô 100, biên độ ±7/10/15%, bước giá, `assertPlausibleVndPrice` (từng bắt lỗi thật: nhầm đơn vị nghìn đồng) |
| `fees.js` | Phí 0,15% + thuế bán 0,1% |
| `guardrails.js` | Hàng rào NGOÀI TẦM VỚI LLM — `checkBuy`/`checkSell`/`checkDailyLoss`, không bao giờ ném lỗi, luôn trả `{ok, reason}` để lưu vào `orders.reject_reason` |
| `engine.js` | **Trọng tài** — agent chỉ đề xuất, engine kiểm luật + guardrail rồi mới khớp; `matchPending()` đối chiếu lệnh LIMIT treo với tick mới |
| `portfolio.js` | `loadPortfolio()` dựng danh mục từ DB, xử lý T+2.5 qua `position_lots` |
| `pnl.js` | `closeSession()` — mark-to-market cuối ngày, `dayPnl` so với snapshot liền trước (không phải vốn gốc) |
| `outcomes.js` | Ghép mua–bán FIFO thành vòng trọn vẹn — mở khoá metrics + lesson scorer |
| `metrics.js` | 6 chỉ số spec §10: win rate, Sharpe (mẫu, n−1), max drawdown, avg holding days, confidence calibration |

### `learning/` và `memory/` — vòng phản tư

| File | Vai trò |
|---|---|
| `learning/scorer.js` | `scoreLesson()` — Laplace smoothing, `RETIRE_BELOW=0.3` sau ≥10 lần thử — chống bảng `lessons` phình thành mê tín |
| `learning/reflect.js` | Cuối phiên, agent tự nhìn lại quyết định và rút bài học mới (gọi LLM) |
| `memory/similarity.js` | Cosine similarity tính trong Node, không pgvector (quy mô vài trăm lesson/agent chưa cần) |
| `memory/retrieval.js` | Lấy top-K bài học liên quan; không có embedder thì suy giảm êm sang xếp theo `confidence` |

---

## 4. `packages/api` — dashboard realtime + báo cáo

**Chỉ đọc, cưỡng chế ở tầng database** (role `stockagents_ro`, chỉ `SELECT`) —
xem [config.js](../packages/api/src/config.js) và migration 008.

| File | Vai trò |
|---|---|
| `server.js` | Dựng repos (đọc), routes, SSE hub, HTTP server thô (không framework) |
| `router.js` | Bảng tra route tối giản — chỉ `GET` (đọc) và `PATCH` (đổi provider/model của agent, KHÔNG đụng danh mục) |
| `routes.js` | Handler cho từng endpoint — `/api/session`, `/api/leaderboard`, `/api/agents/:id/positions` (tự tra giá mới nhất để tính lãi/lỗ tạm tính), `/api/events` |
| `static.js` | Phục vụ file tĩnh (`public/`) |
| `config.js` | Nạp cấu hình dashboard — **từ chối khởi động** nếu mở ra ngoài `localhost` mà thiếu `DASHBOARD_TOKEN` |
| `stream/sse.js` | Hub Server-Sent-Events — `Last-Event-ID` phát lại phần thiếu khi mất mạng giữa chừng, không có khoảng trống giữa lịch sử và realtime |
| `stream/listener.js` | `LISTEN agent_events` trên **một** `pg.Client` riêng (không lấy từ pool, vì `LISTEN` gắn với đúng 1 kết nối) |
| `reporters/telegram.js` | Chỉ đọc rồi gửi — Telegram chết thì phiên vẫn hoàn tất bình thường |
| `cli_report.js` | Gọi tay báo cáo cuối ngày (`report:day`) |
| `public/` | Dashboard tĩnh: `index.html` + `app.js` (SSE, bảng xếp hạng, biểu đồ NAV SVG nội tuyến) + `style.css` (bảng màu theo quy ước giá chứng khoán VN) |

---

## Cấu hình & script gốc

| Đường dẫn | Vai trò |
|---|---|
| `config/agents.json` | Định nghĩa 5 agent — tên, model, `personaPrompt`, vốn, `riskConfig` |
| `config/universe.json` | 30 mã VN30 theo dõi |
| `config/model-catalog.json` | Danh sách model khả dụng mỗi provider — dashboard đọc để hiện dropdown đổi model |
| `ecosystem.config.cjs` | Cấu hình PM2 chạy `data-service` nền bền |
| `scripts/create-db.mjs` | Tạo 2 database (thật + test) từ `.env`, không cần `createdb` trong PATH |
| `scripts/run-tests.mjs` | Chạy toàn bộ test suite của 4 package |

---

## Vòng đời một ngày giao dịch

| Giờ (VN) | Job | Package |
|---|---|---|
| 08:30 | `ingest_prices` | data-service |
| 08:45 | `ingest_news` | data-service |
| 09:00–14:30, mỗi 5' | `poll_quotes` → `watch_tick` | data-service → agent-runtime (spawn) |
| 14:58 | `watch_close` | data-service → agent-runtime (spawn) |
| 15:00 | `report_day` | data-service → api (spawn) |
| 02:00 | `prune_events` | data-service |

`watch_tick` chạy NỐI TIẾP ngay sau `poll_quotes` trong cùng job (không phải
cron riêng) để luôn thấy đúng tick vừa ghi — hai job cùng lịch `*/5` sẽ đua
nhau nếu tách rời. Nhờ vậy một vị thế chạm `STOP_LOSS` lúc 10 giờ sáng được xử
lý trong ≤5 phút, không phải đợi tới cuối phiên.

---

## Ranh giới kiến trúc

Vài quy tắc lặp lại nhiều nơi trong code — hiểu chúng thì đọc phần còn lại
nhanh hơn nhiều:

- **Một điểm chạm cho mỗi hệ thống ngoài.** `cdp/broker.js` là nơi DUY NHẤT
  import `tradingview-mcp`; `news/sources.js` là nơi DUY NHẤT biết
  `tradingview_mcp/news/sources/`. Đổi nhà cung cấp dữ liệu sau này chỉ sửa
  đúng 1 file.
- **`data-service` không `import` `agent-runtime` hay `api`.** Gọi qua tiến
  trình con (`spawnTask` → `npm run ...`) để giữ vòng đời và phụ thuộc tách
  biệt — data-service không cần biết `@anthropic-ai/sdk` tồn tại.
- **Agent chỉ ĐỀ XUẤT, engine mới QUYẾT ĐỊNH.** `sim/guardrails.js` và
  `sim/vn_rules.js` nằm ngoài tầm với của LLM — không prompt nào thuyết phục
  được engine cho mua vượt 20% NAV một mã.
- **Cô lập giữa 5 agent cưỡng chế bằng code**, không phải quy ước —
  `assertAgentScope()` là cửa bắt buộc của mọi repository chạm dữ liệu riêng
  của agent.
- **Dashboard chỉ đọc, cưỡng chế ở tầng DB** (role Postgres, không phải chỉ
  ở route) — một route viết sai hay lỗ hổng injection vẫn không sửa được
  danh mục.
- **Không trigger nào nổ thì không gọi LLM** — chi phí token tỉ lệ với số
  *sự kiện*, không phải số *phút*. `STOP_LOSS`/`TRAILING` còn đi xa hơn: nổ
  thì bán thẳng qua engine, không tốn cả lời gọi LLM.
- **Suy giảm êm, không phải hỏng.** Thiếu embedder → xếp bài học theo
  `confidence`. Thiếu Telegram token → báo cáo tự tắt. `DATA_PARTIAL` → vẫn
  giao dịch, có cảnh báo. Chỉ `DATA_STALE` mới thật sự dừng.
