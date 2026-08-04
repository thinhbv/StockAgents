# Multi-Agent AI Trading System (Giả lập) — Thiết kế hệ thống

> Ngày: 2026-07-26
> Trạng thái: Design — chờ duyệt trước khi lập implementation plan
> Nguồn yêu cầu: `docs/ai_trading_system.md`

---

## 1. Mục tiêu

Xây dựng hệ thống 5 AI agent giao dịch chứng khoán Việt Nam **hoàn toàn giả lập** (không khớp lệnh tiền thật):

- Mỗi agent dùng một model LLM khác nhau và một chiến lược khác nhau.
- Agents hoạt động **độc lập**: không thấy quyết định, không dùng chung memory của nhau.
- Khi phiên mở cửa, mỗi agent tự chọn khoảng 5 mã, quyết định số lượng mua, ghi nhận thời điểm.
- Orchestrator theo dõi liên tục các mã đang giữ, đánh thức agent khi cần quyết định bán.
- Có memory dài hạn và vòng học để agent cải thiện theo thời gian.
- Đo lường và so sánh hiệu quả giữa các agent.

**Ngoài phạm vi:** giao dịch thật, môi giới thật, đòn bẩy, bán khống, phái sinh, tối ưu danh mục đa yếu tố.

---

## 2. Quyết định đã chốt

| Hạng mục | Quyết định |
|---|---|
| Ngôn ngữ | Node.js (ESM), tách thành service riêng, không phải Python/FastAPI |
| Nguồn giá | TradingView Desktop qua CDP là chính, ingest theo lịch vào DB |
| Model | Đa nhà cung cấp: Claude, GPT, Gemini, DeepSeek |
| Database | PostgreSQL + pgvector |
| Luật thị trường | Mô phỏng đầy đủ luật VN (T+2.5, lô chẵn, biên độ, phí, thuế) |
| Universe | Watchlist cấu hình ~20–30 mã |
| Nhịp giao dịch | Mua lúc mở phiên; theo dõi poll 5 phút; đánh thức agent bán theo ngưỡng |
| Web dashboard | SSE + HTML/vanilla JS, **chỉ đọc**, đẩy sự kiện sau khi quyết định hoàn tất |

### Khác biệt có chủ đích so với `ai_trading_system.md`

1. **Không dùng LangChain/LlamaIndex.** Với 5 agent gọi một lượt và RAG chỉ là một truy vấn pgvector, framework thêm tầng trừu tượng nhiều hơn giá trị mang lại. Một module `llm/provider.js` (~150 dòng) đủ dùng và dễ debug hơn.
2. **Không dùng Yahoo Finance / Alpha Vantage.** Không phục vụ tốt thị trường VN. Dùng TradingView CDP + SSI iBoard + các nguồn tin VN đã có sẵn trong `tradingview_mcp/news/`.
3. **Thêm `exitPlan`** — agent tự khai báo ngưỡng thoát ngay lúc mua. Cho phép theo dõi liên tục mà không gọi LLM mỗi nhịp.
4. **Thêm lesson scorer** — chấm điểm và loại bỏ lesson kém, tránh việc `lessons` phình thành nhiễu.

---

## 3. Nguyên tắc kiến trúc

Ba ràng buộc chi phối toàn bộ thiết kế:

**3.1 — CDP là tài nguyên đơn luồng, có trạng thái.**
`chart_set_symbol` đổi symbol cho toàn bộ ứng dụng TradingView. Hai lời gọi đồng thời sẽ đọc nhầm dữ liệu của nhau. Hệ quả: chỉ **một tiến trình duy nhất** được chạm CDP, và mọi lời gọi phải xếp hàng tuần tự qua một broker.

**3.2 — Cô lập giữa các agent phải được cưỡng chế bằng code.**
Yêu cầu "hoạt động độc lập" sẽ bị phá vỡ âm thầm nếu chỉ dựa vào quy ước. Hệ quả: mọi hàm truy cập memory/trade/lesson **bắt buộc** nhận `agentId`; repository layer từ chối truy vấn thiếu nó.

**3.3 — LLM không được giữ quy tắc an toàn.**
Giới hạn vị thế, kiểm tra tiền mặt, T+2.5, biên độ giá đều nằm trong Simulation Engine bằng code. LLM chỉ *đề xuất*; engine là trọng tài và có quyền từ chối.

---

## 4. Kiến trúc tổng thể

```
┌──────────────────┐   ghi    ┌──────────────┐   đọc   ┌────────────────────┐
│   data-service   │ ───────► │  PostgreSQL  │ ◄────── │   agent-runtime    │
│  (độc quyền CDP) │          │  + pgvector  │         │  orchestrator      │
└────────┬─────────┘          └──────┬───────┘         │  5 trading agents  │
         │                           │                 │  simulation engine │
         ▼                           │ đọc             │  learning loop     │
  TradingView Desktop                │                 └─────────┬──────────┘
  news/* (CafeF, VnExpress,          ▼                           │ NOTIFY
          Vietstock, VnEconomy)  ┌──────────┐  LISTEN            │
  SSI iBoard (chỉ số)            │   api    │ ◄──────────────────┘
                                 │ Fastify  │
                                 └────┬─────┘
                                      │ SSE + REST + static
                                      ▼
                              ┌───────────────┐
                              │  Web browser  │  dashboard realtime
                              └───────────────┘
                                      +  Telegram reporter
```

Ba tiến trình riêng biệt, quản lý bằng PM2 (theo pattern `ecosystem.config.cjs` sẵn có).

**Vì sao tách:** data-service crash (TradingView đóng, mất CDP) không kéo sập agents. Agents chạy tiếp trên dữ liệu gần nhất và **biết** dữ liệu đã cũ qua `captured_at`. Nếu độ trễ vượt ngưỡng, agent-runtime từ chối mở phiên — thà không giao dịch còn hơn giao dịch mù.

### Cấu trúc thư mục

```
StockAgents/
├── tradingview_mcp/          ← giữ nguyên, không sửa
├── packages/
│   ├── db/
│   │   ├── migrations/       ← SQL thuần, đánh số tuần tự
│   │   ├── client.js         ← pool pg
│   │   └── repositories/     ← agents, market, orders, positions,
│   │                            trades, memory, lessons, metrics
│   ├── data-service/
│   │   ├── cdp/broker.js     ← mutex + hàng đợi, ĐIỂM DUY NHẤT import tradingview_mcp
│   │   ├── collectors/       ← prices, indicators, quotes, news, indices
│   │   ├── scheduler.js      ← node-cron
│   │   └── index.js
│   ├── agent-runtime/
│   │   ├── orchestrator/     ← session, watchdog, triggers
│   │   ├── agents/           ← registry, runner, prompts/
│   │   ├── llm/              ← provider + anthropic/openai/gemini/deepseek
│   │   ├── memory/           ← short, long, reflection, retrieval
│   │   ├── sim/              ← engine, orders, portfolio, vn_rules, fees, pnl
│   │   ├── learning/         ← evaluator, lessons, scorer
│   │   └── index.js
│   └── api/
│       ├── server.js         ← Fastify: static + REST + SSE
│       ├── routes/           ← agents, positions, decisions, leaderboard, session
│       ├── stream/
│       │   ├── listener.js   ← pg LISTEN agent_events → fan-out
│       │   └── sse.js        ← quản lý client, replay theo Last-Event-ID
│       ├── public/           ← dashboard tĩnh, không build step
│       │   ├── index.html
│       │   ├── app.js
│       │   └── style.css
│       └── reporters/telegram.js
├── config/
│   ├── universe.json         ← danh sách mã
│   └── agents.json           ← 5 định nghĩa agent
└── docs/
```

---

## 5. data-service — người gác cổng dữ liệu

Nhiệm vụ duy nhất: biến thế giới bên ngoài thành hàng trong DB. **Không chứa logic giao dịch.**

### 5.1 CDP Broker

`cdp/broker.js` — mutex + hàng đợi FIFO bọc quanh `tradingview-mcp/core`.

```js
await broker.withSymbol('HOSE:FPT', async (core) => {
  const bars = await core.data.getOhlcv({ count: 60 });
  const ind  = await core.data.getStudyValues();
  return { bars, ind };
});
```

Trách nhiệm:
- Tuần tự hóa mọi truy cập CDP (không bao giờ có 2 lời gọi đồng thời).
- Health check trước mỗi batch; tự gọi `tv_launch()` khi mất kết nối.
- Retry với exponential backoff; sau N lần thất bại thì bỏ mã đó và ghi log, không chặn cả batch.
- Đo và log thời gian mỗi mã để phát hiện suy giảm.

Đây là file **duy nhất** trong toàn hệ thống import `tradingview_mcp`. Mọi thứ khác đọc DB.

### 5.2 Lịch chạy (giờ Việt Nam, T2–T6)

| Giờ | Job | Nội dung | Ghi vào |
|---|---|---|---|
| 08:30 | `ingest_prices` | 30 mã × (`getOhlcv` 60 bars D + `getStudyValues`) ≈ 4s/mã ≈ 2–3 phút | `ohlcv_daily`, `indicator_snapshot` |
| 08:45 | `ingest_news` | `news/index.js`: basic + deep theo từng mã; SSI indices; sinh embedding | `news_items`, `market_index_snapshot` |
| 09:15 | `market_open` | Đánh dấu phiên mở | `session_state` |
| 09:20–14:30 | `poll_quotes` (mỗi 5') | Chỉ các mã **đang có vị thế** (hợp nhất 5 agents, ≤ 25 mã) | `quote_tick` |

**Giờ giao dịch HOSE** — dùng chung cho mọi phase:

| Phiên | Giờ |
|---|---|
| Sáng | 09:00 – 11:30 |
| **Nghỉ trưa** | **11:30 – 13:00 (sàn đóng)** |
| Chiều | 13:00 – 14:30 |
| ATC | 14:30 – 14:45 |

Cửa sổ poll là 09:20–11:30 và 13:00–14:30. Khoảng nghỉ trưa **không** diễn đạt được bằng một chuỗi cron dễ đọc, và chuỗi cron thì không unit-test được — nên cron để rộng (`*/5 9-14`) còn việc chặn giao cho vị từ `isTradingWindow()`, thứ có thể phủ test bằng bảng case.
| 14:45 | `market_close` | Giá đóng cửa toàn universe | `ohlcv_daily`, `session_state` |

Chỉ số kỹ thuật thu thập: RSI(14), MACD(12,26,9), MA20, MA50, MA200, Bollinger Bands(20,2), Volume MA20, ATR(14).

### 5.3 Xử lý lỗi

- Mã lỗi → bỏ qua, ghi `ingest_errors`, batch vẫn tiếp tục.
- Toàn bộ batch lỗi → cảnh báo Telegram, `session_state = DATA_STALE`.
- Ingest là **idempotent**: `UNIQUE(symbol, trade_date)` + `ON CONFLICT DO UPDATE`. Chạy lại job an toàn.

---

## 6. agent-runtime — nơi ra quyết định

### 6.1 Vòng đời phiên

```
PRE_OPEN ──► OPEN ──► WATCHING ──► CLOSING ──► LEARNING ──► IDLE
   │          │          │            │           │
 kiểm tra   agents    watchdog     mark-to-     reflection
 độ tươi    quyết      5 phút      market       mỗi agent
 dữ liệu    định mua                  
```

**PRE_OPEN (09:10)** — xác minh `indicator_snapshot.captured_at` trong ngày và `news_items` đã có. Thiếu → không mở phiên, cảnh báo.

`session_state.state` có ba giá trị sau ingest, và orchestrator phải phân biệt cả ba:

| State | Nghĩa | Orchestrator làm gì |
|---|---|---|
| `DATA_READY` | **Toàn bộ** universe ingest thành công | Mở phiên bình thường |
| `DATA_PARTIAL` | Một phần mã lỗi, hoặc chỉ báo không dựng được | Cảnh báo; chỉ cho agent giao dịch trên các mã thực sự tươi |
| `DATA_STALE` | Không mã nào thành công, hoặc mất CDP | Không mở phiên |

`data_captured_at` **chỉ** được làm mới ở `DATA_READY`. Một lần chạy thành công một phần không được phép làm dấu thời gian trông tươi hơn thực tế — nếu không, chính cơ chế an toàn này sẽ báo xanh đúng lúc cần chặn.

**OPEN (09:15)** — với mỗi agent (tuần tự để tránh vượt rate limit): dựng context → gọi LLM → validate → nộp lệnh cho sim engine.

**WATCHING (09:20–14:30)** — mỗi 5 phút, watchdog đọc `quote_tick` mới nhất và đối chiếu với `exitPlan` của từng vị thế. **Không gọi LLM ở bước này.** Chỉ khi có trigger mới đánh thức agent tương ứng.

**CLOSING (14:45)** — mark-to-market toàn bộ vị thế, ghi `portfolio_snapshot`, tính `metrics_daily`.

**LEARNING (15:30)** — chạy vòng học cho từng agent.

### 6.2 Hợp đồng của agent

Ranh giới quan trọng nhất của hệ thống. Agent là một **hàm thuần**:

```js
decide(context) → Decision[]
```

Agent không biết DB, không biết CDP, không biết agent khác tồn tại. Test được bằng cách bơm context giả.

**Context đưa vào:**

```js
{
  asOf: '2026-07-27T09:15:00+07:00',
  trigger: 'SESSION_OPEN' | 'EXIT_THRESHOLD' | 'NEWS_ALERT',
  market: { vnindex, vn30, breadth, regime: 'UP'|'DOWN'|'SIDEWAYS' },
  universe: [{ symbol, sector, ohlcv60, indicators, quote }],
  news: [{ symbol, title, summary, sentiment, publishedAt }],
  portfolio: { cash, nav, positions: [{ symbol, qty, qtySellable,
                                        avgCost, unrealizedPct, exitPlan,
                                        heldDays }] },
  memory: { recentTrades: [...], lessons: [{ lesson, confidence }] },
  constraints: { maxNewPicks, maxPositions, maxPositionPctNav, minLot,
                 availableCash, tradableSymbols }
}
```

**Quyết định trả về (JSON schema bắt buộc):**

```js
{
  action: 'BUY' | 'SELL' | 'HOLD',
  symbol: 'HOSE:FPT',
  quantity: 1000,                  // bội số của 100
  orderType: 'LIMIT' | 'MARKET' | 'ATC',
  limitPrice: 118500,
  confidence: 0.72,                // 0..1
  reason: 'Vượt MA50 với KL 1.8x, tin kết quả Q2 tích cực',
  exitPlan: {
    takeProfitPct: 8,
    stopLossPct: -4,
    timeStopDays: 10,
    trailingPct: 3                 // tùy chọn
  }
}
```

### 6.3 Cơ chế `exitPlan` — vì sao quan trọng

Agent tuyên bố điều kiện thoát **ngay lúc mua**. Watchdog chỉ thực hiện so sánh số học mỗi 5 phút — không tốn token. Chỉ khi chạm ngưỡng (hoặc có tin nóng về mã đang giữ), agent mới được đánh thức để quyết định bán; lúc đó agent có toàn quyền trả về `HOLD` kèm `exitPlan` mới (ví dụ dời stop lên).

Chi phí token vì thế tỉ lệ với số **sự kiện**, không phải số **phút**. Đây là khác biệt giữa vài chục lời gọi LLM mỗi ngày và vài nghìn.

**Điều kiện đánh thức:**

| Trigger | Điều kiện |
|---|---|
| `TAKE_PROFIT` | `unrealizedPct >= takeProfitPct` |
| `STOP_LOSS` | `unrealizedPct <= stopLossPct` |
| `TRAILING` | Giá tụt `trailingPct` từ đỉnh kể từ lúc mua |
| `TIME_STOP` | `heldDays >= timeStopDays` |
| `NEWS_ALERT` | Tin mới sentiment tiêu cực mạnh về mã đang giữ |
| `EOD_REVIEW` | 14:30 — rà soát một lần trước khi đóng cửa |

Mỗi trigger có debounce: một vị thế không bị đánh thức quá 1 lần / 30 phút cho cùng loại trigger.

### 6.4 Năm agent

| ID | Provider / Model | Phong cách | Đặc trưng prompt |
|---|---|---|---|
| `claude_value` | Anthropic Opus | Giá trị, kiên nhẫn | Ưu tiên tin cơ bản & định giá; giữ dài; stop rộng |
| `gpt_momentum` | OpenAI | Xu hướng | Đuổi breakout; trailing stop; cắt lỗ nhanh |
| `gemini_news` | Google Gemini | Tin tức | Trọng số cao vào `news`; giữ ngắn hạn |
| `deepseek_quant` | DeepSeek | Định lượng | Chỉ dùng số (RSI/MACD/MA/volume/ATR); ít diễn giải |
| `claude_contrarian` | Anthropic Sonnet | Ngược dòng | Mua vùng quá bán; bán vùng hưng phấn |

Mỗi agent = 1 hàng trong bảng `agents` + 1 file prompt trong `agents/prompts/`. Thêm agent thứ 6 là thêm config, không sửa code.

Vốn ảo khởi điểm bằng nhau (mặc định **1.000.000.000 VND**, cấu hình được) để so sánh công bằng.

### 6.5 Lớp LLM adapter

`llm/provider.js` định nghĩa một interface duy nhất:

```js
complete({ system, messages, jsonSchema, maxTokens, temperature }) → object
```

Mỗi provider tự lo cách ép structured output (tool use với Anthropic, response_format với OpenAI, responseSchema với Gemini...). Bên gọi không cần biết.

Xử lý lỗi: retry với backoff khi rate limit; nếu provider chết hẳn, agent đó **bỏ lượt** (`SKIPPED`) và ghi log — **không** fallback sang model khác, vì như vậy sẽ làm hỏng việc so sánh giữa các model.

---

## 7. Simulation Engine — trọng tài luật VN

Toàn bộ luật nằm ở đây; agent không thể lách.

### 7.1 Luật thị trường

| Luật | Cài đặt |
|---|---|
| **T+2.5** | Mỗi lô mua có `sellable_from = trade_date + 2 phiên`. Vị thế lưu `qty_total` và `qty_sellable`. Lệnh bán vượt `qty_sellable` → reject. |
| **Lô chẵn** | Khối lượng phải là bội của 100. Làm tròn xuống; dư < 100 → reject. |
| **Biên độ giá** | HOSE ±7%, HNX ±10%, UPCOM ±15% trên giá tham chiếu. Lệnh ngoài biên → reject. |
| **Bước giá** | HOSE: 10đ (<10k), 50đ (10k–49.95k), 100đ (≥50k). Làm tròn về bước giá hợp lệ. |
| **Phí giao dịch** | 0,15% giá trị khớp, cả mua và bán. |
| **Thuế** | 0,1% giá trị bán (thuế TNCN). |
| **Trượt giá** | Khớp tại quote gần nhất ± spread mô hình theo thanh khoản (mặc định 0,1%). |

Lệnh bị từ chối được ghi vào `orders` với `status='REJECTED'` và `reject_reason`. Đây là dữ liệu học có giá trị — agent nên học được rằng nó đang cố làm điều bất khả thi.

### 7.2 Guardrails cứng (ngoài tầm với của LLM)

- Tối đa `maxPositions` vị thế đồng thời / agent (mặc định 8).
- Tối đa `maxPositionPctNav` cho một mã (mặc định 20% NAV).
- Không đòn bẩy: tổng giá trị mua ≤ tiền mặt khả dụng.
- Không bán khống: không bán quá `qty_sellable`.
- Chặn giao dịch phần còn lại của ngày nếu lỗ trong ngày vượt `dailyLossLimitPct` (mặc định −5% NAV).

Vi phạm guardrail → reject + ghi log, **không** phải crash.

### 7.3 Mô hình khớp lệnh

- `MARKET` — khớp tại quote gần nhất + trượt giá.
- `LIMIT` — khớp nếu quote chạm giá; nếu không, treo đến cuối phiên rồi hủy.
- `ATC` — khớp tại giá đóng cửa.

---

## 8. Memory & Learning

### 8.1 Ba tầng memory

| Tầng | Lưu ở | Nội dung | Vòng đời |
|---|---|---|---|
| **Short-term** | RAM (trong process) | Context phiên hiện tại, các quyết định trong ngày | Xóa cuối phiên; có trần token |
| **Long-term** | `trades`, `trade_outcomes` | Toàn bộ lịch sử giao dịch kèm reasoning gốc và kết quả thực | Vĩnh viễn |
| **Reflection** | `lessons` (+ embedding) | Bài học rút ra, có điểm tin cậy | Vĩnh viễn, có cắt tỉa |

### 8.2 RAG retrieval

1. Dựng chuỗi truy vấn từ context hiện tại (mã + ngành + chế độ thị trường).
2. Sinh embedding.
3. Truy vấn pgvector: top-k lessons **chỉ của agent đó** (`WHERE agent_id = $1`), sắp xếp theo `similarity × confidence`.
4. Chèn vào prompt (tối đa 10 lessons, cắt theo token budget).

Cô lập được cưỡng chế ở repository: hàm truy vấn lessons không có tham số `agentId` tùy chọn — nó là bắt buộc.

### 8.3 Vòng học (15:30 hằng ngày)

Với mỗi agent:

1. Lấy các trade **đã đóng** trong ngày: reasoning gốc + kết quả thực tế (PnL, số ngày giữ).
2. Lấy các vị thế đang mở kèm lãi/lỗ tạm tính.
3. Đưa cho **chính model của agent đó** (không phải model khác) để sinh lessons:
   ```js
   { lesson: '...', confidence: 0.6, evidenceTradeIds: [123, 145] }
   ```
4. Khử trùng lặp bằng similarity: nếu lesson mới gần giống lesson cũ (cosine > 0.9), cộng dồn confidence thay vì tạo hàng mới.

### 8.4 Lesson scorer — chống tự đầu độc

Không có bước này, `lessons` sẽ phình thành một đống mê tín và ngày càng làm nhiễu prompt. Đây là chế độ hỏng phổ biến nhất của kiến trúc reflection.

1. Mỗi lần một lesson được truy xuất và đưa vào prompt, ghi `lesson_usage(lesson_id, trade_id)`.
2. Khi trade đó đóng: lãi → `times_helped++`; lỗ → không tăng. `times_retrieved++` trong cả hai trường hợp.
3. Cập nhật `confidence = (times_helped + 1) / (times_retrieved + 2)` (làm mượt Laplace).
4. Lesson có `confidence < 0.3` **và** `times_retrieved >= 10` → đánh dấu `retired`, ngừng truy xuất.

---

## 9. Database schema

```sql
-- ===== Cấu hình =====
agents(id TEXT PK, name, provider, model, persona_prompt, initial_capital NUMERIC,
       risk_config JSONB, active BOOL)
universe(symbol TEXT PK, exchange, sector, name, active BOOL)

-- ===== Dữ liệu thị trường (data-service ghi) =====
ohlcv_daily(symbol, trade_date, open, high, low, close, volume,
            UNIQUE(symbol, trade_date))
indicator_snapshot(id, symbol, captured_at, payload JSONB)
quote_tick(id, symbol, ts, price, volume)
market_index_snapshot(id, index_code, captured_at, value, change_pct)
news_items(id, symbol NULL, source, url, title, summary, sentiment,
           published_at, embedding VECTOR(1536))
session_state(trade_date PK, state, data_captured_at, note)
ingest_errors(id, job, symbol, message, occurred_at)

-- ===== Giao dịch (agent-runtime ghi) =====
orders(id, agent_id, symbol, side, qty, order_type, limit_price,
       status, reject_reason, created_at)
fills(id, order_id, agent_id NOT NULL, qty, price, fee, tax, filled_at)
      -- agent_id là bắt buộc dù suy ra được từ orders: assertAgentScope()
      -- không bảo vệ nổi bảng thiếu cột này, và cô lập agent (§3.2) phải
      -- được cưỡng chế bằng code. Có trigger chặn lệch với orders.agent_id.
positions(id, agent_id, symbol, qty_total, qty_sellable, avg_cost,
          exit_plan JSONB, peak_price, opened_at, closed_at NULL,
          UNIQUE(agent_id, symbol) WHERE closed_at IS NULL)
position_lots(id, position_id, qty, cost, sellable_from)
trades(id, agent_id, symbol, action, price, qty, reason,
       confidence CHECK 0..1, trigger, context_ref JSONB, decided_at)
trade_outcomes(trade_id PK, exit_trade_id, pnl, pnl_pct, holding_days)

-- ===== Memory =====
lessons(id, agent_id, lesson, confidence, times_retrieved, times_helped,
        evidence_trade_ids INT[], embedding VECTOR(1536), retired BOOL, created_at)
lesson_usage(id, lesson_id, trade_id, outcome)

-- ===== Sự kiện (nguồn cấp cho dashboard) =====
event_log(id BIGSERIAL PK, ts TIMESTAMPTZ, type TEXT, agent_id TEXT NULL,
          symbol TEXT NULL, payload JSONB)

-- ===== Đo lường =====
portfolio_snapshot(agent_id, snap_date, cash, market_value, nav, day_pnl,
                   PRIMARY KEY(agent_id, snap_date))
metrics_daily(agent_id, snap_date, total_return_pct, win_rate, sharpe,
              max_drawdown, avg_holding_days, trade_count,
              PRIMARY KEY(agent_id, snap_date))
```

**Bất biến bắt buộc:** mọi bảng thuộc về agent đều có `agent_id NOT NULL`, và repository layer không cho phép truy vấn thiếu nó.

Index: `(symbol, trade_date DESC)` trên `ohlcv_daily`; `(symbol, ts DESC)` trên `quote_tick`; ivfflat trên cột `embedding`.

---

## 10. Metrics

Tính trong `metrics_daily`, hiển thị qua API/Telegram:

| Metric | Công thức |
|---|---|
| Total return | `(nav - initial_capital) / initial_capital` |
| Win rate | trade lãi / tổng trade đã đóng |
| Sharpe ratio | `mean(daily_return) / stddev(daily_return) × √252` |
| Max drawdown | sụt giảm sâu nhất từ đỉnh NAV |
| Avg holding days | trung bình `holding_days` |
| Lesson hit rate | `times_helped / times_retrieved` toàn agent |

Bảng xếp hạng 5 agent gửi Telegram cuối mỗi phiên và tổng kết cuối tuần.

---

## 11. Web dashboard realtime

Mục đích: quan sát **trạng thái, lý luận, chiến lược và danh mục** của từng agent trong lúc hệ thống chạy. Chỉ đọc — không có endpoint ghi, không có nút can thiệp. Lý do: mọi can thiệp tay đều làm nhiễu việc so sánh giữa 5 agent, vốn là mục đích chính của hệ thống.

### 11.1 Đường đi của sự kiện

```
agent-runtime          PostgreSQL              api                browser
──────────────         ──────────              ───                ───────
emit(event)  ──► INSERT event_log
             ──► NOTIFY agent_events  ──► LISTEN ──► fan-out ──► SSE /api/stream
```

**Vì sao dùng Postgres LISTEN/NOTIFY:** agent-runtime và api là hai tiến trình riêng. LISTEN/NOTIFY nối chúng mà không cần thêm Redis hay message broker — DB vốn đã là hạ tầng bắt buộc.

Payload của `NOTIFY` giới hạn 8000 byte, nên chỉ gửi phong bì gọn: `{ id, type, agentId }`. API nhận được thì đọc chi tiết từ `event_log` theo `id` rồi mới đẩy đầy đủ qua SSE. Cách này cũng khiến `event_log` trở thành nguồn sự thật duy nhất, không phải một bản sao dễ lệch.

**Chống mất sự kiện:** mỗi message SSE mang `id:` bằng `event_log.id`. Khi trình duyệt mất kết nối, EventSource tự kết nối lại kèm header `Last-Event-ID`; API phát lại mọi sự kiện có `id` lớn hơn giá trị đó. Không mất sự kiện khi mạng chập chờn hay khi restart api.

### 11.2 Danh mục sự kiện

| Type | Khi nào | Payload chính |
|---|---|---|
| `session.state` | Chuyển trạng thái phiên | `state`, `dataCapturedAt` |
| `data.ingested` | Xong một job ingest | `job`, `symbolCount`, `durationMs` |
| `data.stale` | Dữ liệu quá cũ | `ageMinutes` |
| `agent.started` | Agent bắt đầu một lượt quyết định | `trigger`, `symbolsInScope` |
| `agent.decided` | Agent trả kết quả | `decisions[]` đầy đủ: action, symbol, qty, `reason`, `confidence`, `exitPlan` |
| `agent.skipped` | Provider lỗi, agent bỏ lượt | `error` |
| `order.placed` | Nộp lệnh cho sim | `side`, `symbol`, `qty`, `limitPrice` |
| `order.filled` | Khớp | `price`, `fee`, `tax` |
| `order.rejected` | Vi phạm luật/guardrail | `rejectReason` |
| `trigger.fired` | Watchdog chạm ngưỡng | `triggerType`, `symbol`, `unrealizedPct` |
| `position.marked` | Mark-to-market mỗi 5 phút | `symbol`, `price`, `unrealizedPct` |
| `lesson.created` | Vòng học sinh lesson | `lesson`, `confidence` |
| `metrics.updated` | Cuối phiên | `nav`, `dayPnl`, `winRate` |

Vì đã chốt **không stream từng chữ**, `agent.started` chỉ báo "đang suy nghĩ" (UI hiện trạng thái chờ), và `agent.decided` mang toàn bộ lý luận một lần. Lớp `llm/provider.js` không cần chế độ streaming — giữ được sự đơn giản.

### 11.3 Giao diện

Một trang duy nhất, ba vùng:

```
┌──────────────────────────────────────────────────────────────────────┐
│ ● WATCHING   09:47   VNINDEX 1,284.5 ▲0.8%   dữ liệu: 08:31 (tươi)   │
├───────────────────────────────────────────────┬──────────────────────┤
│  BẢNG XẾP HẠNG                                │  DÒNG SỰ KIỆN        │
│  ┌────────────┬────────────┬────────────┐     │                      │
│  │claude_value│gpt_momentum│gemini_news │ ... │  09:47 ⚡ trigger    │
│  │ 1.043 tỷ   │ 0.987 tỷ   │ 1.012 tỷ   │     │   TAKE_PROFIT FPT    │
│  │ ▲ +4.3%    │ ▼ -1.3%    │ ▲ +1.2%    │     │   claude_value       │
│  │ 5 vị thế   │ 7 vị thế   │ 4 vị thế   │     │  09:47 🤔 đang nghĩ  │
│  │ ● idle     │ 🤔 đang nghĩ│ ● idle    │     │  09:48 ✅ BÁN FPT    │
│  └────────────┴────────────┴────────────┘     │   1.000cp @ 118.5    │
│  ────────────────────────────────────────     │  09:48 💰 khớp lệnh  │
│  CHI TIẾT: claude_value                       │                      │
│  Model: Claude Opus · Giá trị, kiên nhẫn      │                      │
│                                               │                      │
│  VỊ THẾ                                       │                      │
│   FPT  1.000cp  vốn 109,5k  ▲+8.2%  ████░ TP  │                      │
│   VCB    500cp  vốn  92,0k  ▼-1,1%  ░░█░░     │                      │
│                                               │                      │
│  NHẬT KÝ LÝ LUẬN                              │                      │
│   09:15 MUA FPT · tin cậy 0,72                │                      │
│   "Vượt MA50 với KL 1.8x, tin KQ Q2 tích cực" │                      │
│   Kế hoạch thoát: TP +8% / SL −4% / 10 phiên  │                      │
│                                               │                      │
│  LESSONS ĐANG DÙNG                            │                      │
│   0,81  Tránh mua đuổi khi RSI > 70           │                      │
└───────────────────────────────────────────────┴──────────────────────┘
```

- **Header** — trạng thái phiên, đồng hồ, VNINDEX, và **độ tươi dữ liệu**. Ô cuối chuyển đỏ khi `data.stale`; đây là thứ cần thấy đầu tiên khi có sự cố.
- **Bảng xếp hạng** — 5 thẻ agent. Nhấn vào thẻ để mở chi tiết bên dưới; lựa chọn lưu ở `localStorage` để reload không mất.
- **Chi tiết agent** — chiến lược (model + persona), vị thế đang giữ kèm thanh tiến độ trực quan giữa stop-loss và take-profit, nhật ký lý luận theo thời gian, và các lesson đang được truy xuất.
- **Dòng sự kiện** — toàn hệ thống, mới nhất trên cùng, giới hạn 200 mục trong DOM.

Hiển thị màu theo lãi/lỗ, kèm ký hiệu ▲▼ để không phụ thuộc hoàn toàn vào màu sắc. Số tiền định dạng theo locale VN.

### 11.4 API

Tất cả `GET`, không có phương thức ghi.

| Endpoint | Trả về |
|---|---|
| `GET /api/session` | Trạng thái phiên, độ tươi dữ liệu, chỉ số thị trường |
| `GET /api/leaderboard` | 5 agent: NAV, lãi/lỗ, số vị thế, trạng thái hiện tại |
| `GET /api/agents/:id` | Cấu hình: model, persona, tham số rủi ro |
| `GET /api/agents/:id/positions` | Vị thế đang mở kèm mark-to-market và `exitPlan` |
| `GET /api/agents/:id/decisions?limit=50` | Nhật ký lý luận (từ `trades`) |
| `GET /api/agents/:id/lessons` | Lessons đang hoạt động, sắp theo `confidence` |
| `GET /api/events?since=<id>&limit=200` | Nạp lịch sử khi mở trang |
| `GET /api/stream` | SSE — sự kiện realtime, hỗ trợ `Last-Event-ID` |

Khi mở trang: gọi `/api/session` + `/api/leaderboard` + `/api/events?since=0` để dựng trạng thái ban đầu, rồi mở SSE từ `id` lớn nhất đã nhận. Không có khoảng trống giữa lịch sử và realtime.

### 11.5 Vận hành

- Mặc định bind `127.0.0.1:8080`. Muốn mở ra LAN thì đặt `DASHBOARD_HOST=0.0.0.0` **và** `DASHBOARD_TOKEN` — không có token thì server từ chối bind ra ngoài localhost.
- Giới hạn 20 kết nối SSE đồng thời; heartbeat comment mỗi 25 giây để proxy không cắt kết nối.
- Không build step, không dependency frontend. Sửa `public/app.js` rồi F5 là thấy.
- `event_log` cắt tỉa: xóa bản ghi cũ hơn 90 ngày bằng job hằng đêm.

---

## 12. Chiến lược kiểm thử

| Loại | File | Cần gì | Bao phủ |
|---|---|---|---|
| Unit | `sim/vn_rules.test.js` | Không | Bảng case: T+2.5, lô chẵn, biên độ, bước giá, phí, thuế |
| Unit | `sim/engine.test.js` | Không | Vòng đời lệnh với LLM stub trả quyết định ghi sẵn |
| Unit | `learning/scorer.test.js` | Không | Cập nhật confidence, luật cắt tỉa |
| Contract | `llm/provider.test.js` | API keys | Mỗi provider trả đúng JSON schema — chỗ hay vỡ nhất khi đổi nhà cung cấp |
| Integration | `db/repositories.test.js` | Postgres | Cưỡng chế cô lập theo `agent_id`; idempotency của ingest |
| Integration | `api/stream.test.js` | Postgres | NOTIFY → SSE tới nơi; `Last-Event-ID` phát lại đúng, không trùng không sót |
| Unit | `api/routes.test.js` | Không | Mọi route chỉ đọc; không route nào nhận POST/PUT/DELETE |
| Replay | `replay/harness.test.js` | Fixture | Nạp snapshot một ngày lịch sử, chạy trọn phiên tất định |

**Replay harness** là công cụ quan trọng nhất: cho phép hồi quy khi sửa engine và so sánh agents trên cùng một tập dữ liệu.

---

## 13. Cấu hình & bảo mật

`.env` bổ sung:

```env
DATABASE_URL=postgres://user:pass@localhost:5432/stockagents

ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
DEEPSEEK_API_KEY=

TRADING_ENABLED=true            # công tắc tổng
INITIAL_CAPITAL=1000000000
PICKS_PER_SESSION=5             # số mã tối đa agent được mua mỗi phiên mở cửa
MAX_POSITIONS=8
MAX_POSITION_PCT_NAV=20
DAILY_LOSS_LIMIT_PCT=5
DATA_STALENESS_MINUTES=90

DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=8080
DASHBOARD_TOKEN=               # bắt buộc nếu HOST khác 127.0.0.1
EVENT_LOG_RETENTION_DAYS=90
```

- API keys chỉ đọc từ env, không bao giờ ghi vào DB hay log.
- **Không có đường nối nào tới môi giới thật.** Hệ thống không có khái niệm "đặt lệnh thật"; mọi lệnh đi qua `sim/engine.js`.
- Đầu ra LLM luôn được validate theo JSON schema **trước khi** chạm sim engine.
- Dashboard chỉ đọc: `api` kết nối DB bằng **role chỉ có quyền SELECT** (+ LISTEN). Kể cả khi có lỗ hổng injection, cũng không ghi được gì.
- `event_log.payload` không bao giờ chứa prompt thô hay API key — chỉ chứa lý luận đã hoàn tất và số liệu.

---

## 14. Lộ trình triển khai

| Phase | Nội dung | Kết quả kiểm chứng được |
|---|---|---|
| 1 | DB schema + migrations + repositories + `event_log` + data-service (CDP broker, ingest giá & chỉ báo) | Dữ liệu 30 mã tự chảy vào DB mỗi sáng, chạy lại an toàn |
| 2 | Sim engine + luật VN đầy đủ + 1 agent Claude | 1 agent trade giả lập trọn phiên, PnL đúng luật, test luật VN xanh |
| 3 | Orchestrator + watchdog + `exitPlan` + emit sự kiện | Tự mua lúc mở cửa, tự thoát theo ngưỡng, không tốn LLM khi rảnh |
| 4 | **API + web dashboard SSE** | Mở trình duyệt thấy 1 agent chạy realtime — công cụ quan sát cho các phase sau |
| 5 | LLM adapters + 4 agent còn lại | 5 agents chạy song song, bảng xếp hạng trên dashboard, cô lập được kiểm chứng |
| 6 | Memory + RAG + learning loop + lesson scorer | Lessons sinh ra, được truy xuất, được chấm điểm và cắt tỉa |
| 7 | Ingest tin tức đầy đủ + báo cáo Telegram | Tin tức vào context agent; tổng kết hằng ngày qua Telegram |

Dashboard đặt ở Phase 4 — **trước** khi thêm 4 agent và learning loop — vì từ đó trở đi việc debug bằng log sẽ rất khổ. Có mắt nhìn trước rồi mới tăng độ phức tạp.

Mỗi phase kết thúc bằng một hệ thống chạy được, không phải một tầng code chưa dùng tới.

---

## 15. Rủi ro đã biết

| Rủi ro | Giảm thiểu |
|---|---|
| TradingView Desktop đóng hoặc CDP đứt | Broker health-check + `tv_launch()`; agents từ chối mở phiên khi dữ liệu cũ |
| Rate limit / provider chết | Retry backoff; agent bỏ lượt thay vì đổi model (giữ tính công bằng so sánh) |
| Lessons phình thành nhiễu | Lesson scorer + cắt tỉa + trần 10 lessons/prompt |
| Chi phí token vượt dự tính | `exitPlan` + debounce trigger; theo dõi token/ngày và cảnh báo |
| Rò rỉ dữ liệu giữa agents | `agent_id` bắt buộc ở repository layer + integration test kiểm chứng |
| Đầu ra LLM sai định dạng | JSON schema + validate + reject có ghi log, không crash |
| Mất sự kiện khi mạng chập chờn / restart api | `event_log` là nguồn sự thật; SSE phát lại theo `Last-Event-ID` |
| `event_log` phình to | Job cắt tỉa hằng đêm theo `EVENT_LOG_RETENTION_DAYS` |
| Dashboard lộ ra internet | Mặc định bind localhost; muốn mở rộng phải có `DASHBOARD_TOKEN`; DB role chỉ SELECT |

---

## 16. Câu hỏi mở

Không có. Mọi hạng mục đã được chốt ở mục 2.
