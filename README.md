# StockAgents

Hệ thống multi-agent AI giao dịch chứng khoán Việt Nam — **hoàn toàn giả lập**.
Không kết nối tới môi giới thật, không đặt lệnh bằng tiền thật.

**→ [Hướng dẫn sử dụng](docs/huong-dan-su-dung.md)** — cài đặt, chạy hằng ngày,
đọc dashboard, xử lý sự cố. Bắt đầu từ đây nếu bạn muốn *dùng* hệ thống.

**→ [Kiến trúc hệ thống](docs/kien-truc-he-thong.md)** — 4 package, luồng dữ
liệu giữa chúng, và vai trò từng module bên trong.

**→ [Thiết kế database](docs/thiet-ke-database.md)** — 22 bảng, quan hệ giữa
chúng, và vì sao mỗi bảng có hình dạng như vậy.

README này giải thích *vì sao* từng phần được làm như vậy.

Thiết kế: [docs/superpowers/specs/2026-07-26-ai-trading-agents-design.md](docs/superpowers/specs/2026-07-26-ai-trading-agents-design.md)

## Yêu cầu

- Node.js >= 20.20
- PostgreSQL 18 (pgvector chỉ cần từ Phase 6)
- TradingView Desktop chạy với CDP port 9222 (cho data-service)

## Cài đặt

```bash
npm install
cp .env.example .env      # điền DATABASE_URL
npm run db:create         # tạo 2 database (không cần createdb trong PATH)
npm run migrate
```

## Chạy

```bash
npm run data-service      # scheduler chạy nền
npm run ingest:prices     # chạy tay một lần
npm run poll:quotes
```

## Test

```bash
npm test                  # cần DATABASE_URL_TEST
```

## Phase 1 gồm những gì

`packages/db` — schema, migrations, repositories.
`packages/data-service` — CDP broker, collectors, jobs, scheduler.

Chỉ `packages/data-service/src/cdp/broker.js`, `src/index.js` và `src/cli.js` được import `tradingview-mcp`.
Mọi thành phần khác đọc từ database.

## Trạng thái phiên (`session_state`)

Sau mỗi lần chạy `ingest_prices`, `ops.setSessionState` ghi một trong ba trạng thái:

- `DATA_READY` — toàn bộ mã trong universe ingest thành công VÀ chỉ báo (indicators) thiết lập được.
- `DATA_PARTIAL` — một phần mã thất bại, hoặc chỉ báo không thiết lập được dù giá vẫn lấy được.
- `DATA_STALE` — không mã nào thành công, hoặc CDP không khả dụng (TradingView Desktop chưa chạy/không kết nối được).

Orchestrator dựa vào trạng thái này để quyết định có mở phiên giao dịch cho các agent hay không.

## Phase 2 — Simulation Engine

Một agent giao dịch giả lập trọn phiên, tuân thủ luật thị trường VN.

```bash
npm run sim:session -- --agent claude_value --date 2026-07-20 --stub
```

`--stub` dùng LLM giả tất định, không cần API key. Bỏ cờ này để chạy với
Claude thật (cần `ANTHROPIC_API_KEY` trong `.env`).

**Đơn vị giá:** TradingView trả giá cổ phiếu VN **đã tính bằng VND** — kiểm
chứng trên dữ liệu thật: FPT 67.000, HPG 21.800, VCB 14.400. Nên `PRICE_SCALE`
mặc định là **1**, không phải 1000. `assertPlausibleVndPrice()` chặn giá ngoài
khoảng 1.000–10.000.000 VND, và chính nó đã bắt được giả định sai ban đầu.

**Chỉ báo tự tính từ `ohlcv_daily`**, không đọc từ TradingView.
`getStudyValues()` lấy giá trị từ Data Window mà TradingView chỉ điền khi con
trỏ nằm trên chart — chạy tự động lúc 8h30 thì nó trả rỗng. Đã kiểm chứng:
chart có RSI nhưng `getStudyValues()` chỉ trả `["Volume"]`.

**Luật đã mô phỏng:** T+2.5 theo từng lô, lô chẵn 100, biên độ ±7%/±10%/±15%,
bước giá ba bậc, phí 0,15%, thuế bán 0,1%, trượt giá 0,1% theo hướng bất lợi.

**Hàng rào cứng** (ngoài tầm với của LLM): tối đa 20% NAV một mã, không đòn
bẩy, không bán khống, dừng giao dịch khi lỗ ngày vượt 5% NAV. Không giới hạn
số loại mã đang giữ — agent tự quyết định dàn trải bao nhiêu mã.

**Trạng thái phiên:** `DATA_READY` / `DATA_PARTIAL` / `DATA_STALE`. Chỉ
`DATA_READY` mới làm mới `data_captured_at`.

## Phase 3 — Orchestrator & Watchdog

Chạy trọn một ngày mô phỏng: mở phiên, theo dõi, tự thoát vị thế.

```bash
npm run sim:day -- --agent claude_value --date 2026-07-29 --stub
```

**Cơ chế đánh thức:** agent khai `exitPlan` ngay lúc mua. Watchdog so sánh số
học mỗi nhịp tick — **không gọi LLM**. Chỉ khi chạm ngưỡng mới đánh thức agent,
nên chi phí token tỉ lệ với số *sự kiện*, không phải số *phút*.

| Trigger | Điều kiện | Khi nổ |
|---|---|---|
| `STOP_LOSS` | lỗ chạm `stopLossPct` | **Tự động bán ngay** qua engine, không hỏi LLM |
| `TRAILING` | tụt `trailingPct` từ **đỉnh** kể từ lúc mua | **Tự động bán ngay** qua engine, không hỏi LLM |
| `TAKE_PROFIT` | lãi chạm `takeProfitPct` | Đánh thức agent, LLM tự quyết (bán/giữ/đổi kế hoạch) |
| `TIME_STOP` | giữ đủ `timeStopDays` phiên | Đánh thức agent |
| `NEWS_ALERT` | sentiment tin ≤ −0,5 | Đánh thức agent |
| `EOD_REVIEW` | từ 14:30 giờ VN | Đánh thức agent |

`STOP_LOSS`/`TRAILING` là ngưỡng **bảo vệ vốn** — chờ LLM cân nhắc lại đúng lúc
giá đang rơi là mất thêm tiền (dù là tiền giả lập), nên bán thẳng qua
`engine.submit()` (packages/agent-runtime/src/orchestrator/watchdog.js). Các
trigger còn lại là lúc *có thể* đáng cân nhắc tiếp, quyết định vẫn thuộc về
agent — đây mới là phần hệ thống sinh ra để so sánh.

Mỗi vị thế chịu chống rung 30 phút cho **cùng** loại trigger.

**Theo dõi liên tục trong giờ, không phải chỉ 1 lần đầu ngày.** `sim:day`/
`sim:all` là replay theo lô (nạp sẵn tick rồi chạy 1 lượt, dùng để xem lại/test
tay). Chạy tự động thật (`data-service`) dùng `watch:tick` — gọi lại mỗi 5
phút ngay sau `poll_quotes`, mở phiên nếu agent chưa mở rồi watchdog tick đúng
1 lần với giá mới nhất — và `watch:close` lúc 14:58 để chốt sổ. Nhờ vậy một vị
thế chạm cắt lỗ lúc 10 giờ sáng được xử lý trong vòng 5 phút, không phải đợi
tới cuối ngày.

**Cổng dữ liệu:** phiên chỉ mở khi `session_state` là `DATA_READY` hoặc
`DATA_PARTIAL`. `DATA_STALE` thì không mở — thà không giao dịch còn hơn
giao dịch mù.

**Máy trạng thái:** `PRE_OPEN → OPEN → WATCHING → CLOSING → IDLE`, mỗi bước
phát một sự kiện `session.state` vào `event_log` cho dashboard Phase 4 đọc.

## Phase 4 — Dashboard realtime

```bash
npm run api      # http://127.0.0.1:8080
```

Mở trình duyệt rồi chạy `npm run sim:day` ở tab khác — sự kiện hiện lên ngay,
không cần F5.

**Chỉ đọc, cưỡng chế ở tầng database.** `api` kết nối bằng role
`stockagents_ro` chỉ có quyền `SELECT`. Một route viết sai, hay một lỗ hổng
injection, vẫn không sửa được danh mục. Mọi phương thức khác `GET` trả 405.

**Không có khoảng trống giữa lịch sử và realtime.** Trang nạp
`/api/events?since=0` trước, rồi mở SSE từ `id` lớn nhất đã thấy. Mất mạng
giữa chừng thì `Last-Event-ID` phát lại phần thiếu.

**Mở ra ngoài localhost** cần `DASHBOARD_TOKEN`; thiếu token thì server từ
chối khởi động chứ không im lặng phơi dữ liệu.

Bảng màu lấy từ quy ước bảng giá chứng khoán VN: tím = trần/chốt lời,
xanh lơ = sàn/cắt lỗ, vàng = tham chiếu, xanh = tăng, đỏ = giảm.

## Phase 5 — Năm agent, bốn nhà cung cấp

```bash
npm run sim:all -- --date 2026-07-29 --stub
```

| Agent | Model |
|---|---|
| `claude_value` | Claude Opus |
| `gpt_momentum` | GPT |
| `gemini_news` | Gemini |
| `deepseek_quant` | DeepSeek |
| `claude_contrarian` | Claude Sonnet |

Cả 5 agent dùng **chung một persona** "nhà đầu tư chuyên nghiệp tự lý luận" —
không gán sẵn trường phái (giá trị/xu hướng/tin tức/định lượng/ngược dòng) hay
ngưỡng số cứng (% cắt lỗ, RSI...). Agent tự đọc dữ liệu context và tự quyết
định chiến lược, quy mô vị thế, điểm cắt lỗ/chốt lời cho từng tình huống —
giống một trader thật tự chịu trách nhiệm với vốn của mình. Khác biệt hành vi
giữa 5 agent vì vậy chỉ còn đến từ **model** đứng sau, không phải từ kịch bản
chiến lược viết sẵn trong `config/agents.json`.

Bỏ `--stub` để chạy với model thật — cần `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `DEEPSEEK_API_KEY` trong `.env`. Thiếu key nào, CLI nói rõ
key nào thiếu và dừng, thay vì chạy nửa vời.

**Provider chết thì agent bỏ lượt**, không đổi sang model khác — đổi model sẽ
làm hỏng chính việc so sánh mà hệ thống này sinh ra để làm.

## Phase 6 — Memory, RAG và lesson scorer

Cuối mỗi phiên agent nhìn lại lệnh của chính mình và rút bài học. Bài học
được nhúng vector, lưu vào `lessons`, và quay lại prompt phiên sau.

**Không dùng pgvector.** PostgreSQL 18 trên máy chưa có extension, và ở quy mô
vài trăm bài học mỗi agent thì cosine similarity tính trong Node nhanh hơn chi
phí vận hành thêm một extension. Muốn đổi sang pgvector chỉ cần thay hàm
`topK` trong `memory/similarity.js`.

**Xếp hạng theo `similarity × confidence`**, không chỉ theo độ giống. Một bài
học rất khớp ngữ cảnh nhưng đã chứng minh là vô dụng không được đứng trên bài
học hơi kém khớp nhưng đã cứu nhiều lệnh.

**Lesson scorer chống tự đầu độc.** Bài học dùng cho lệnh lãi thì tăng điểm,
lệnh lỗ thì không. Làm mượt Laplace nên trúng một lần không nhảy lên 1,0. Bài
học dưới 0,3 điểm **và** đã được thử ít nhất 10 lần thì bị loại vĩnh viễn.
Không có cơ chế này, `lessons` sẽ phình thành một đống mê tín làm nhiễu prompt
— chế độ hỏng phổ biến nhất của kiến trúc reflection.

Bài học do **chính model của agent đó** sinh ra. Dùng chung một model để rút
kinh nghiệm cho cả năm agent sẽ khiến chúng dần hội tụ về một lối nghĩ, và
việc so sánh mất ý nghĩa.

## Phase 7 — Tin tức và báo cáo Telegram

Tin tức từ các nguồn VN được thu về `news_items`, tự gắn mã, và chấm điểm
cảm xúc. Watchdog dùng điểm này làm một trong sáu điều kiện đánh thức agent.

**Chấm điểm bằng từ điển, không dùng LLM.** Tin về ba mươi mã mỗi ngày là
hàng trăm lời gọi, trong khi thứ hệ thống cần chỉ là tín hiệu thô đủ để quyết
định *có đánh thức agent hay không*. Agent tự đọc tiêu đề trong context và tự
đánh giá. Dùng LLM ở đây là trả tiền cho độ chính xác không ai dùng tới.

**Lấy sentiment TỆ NHẤT trong 24 giờ**, không lấy trung bình — một tin rất
xấu bị vài tin trung tính pha loãng sẽ không đánh thức được ai.

**Telegram chỉ đọc rồi gửi.** Nếu Telegram chết, phiên giao dịch vẫn hoàn tất
bình thường. Thiếu `TELEGRAM_TOKEN` hoặc `TELEGRAM_CHAT_ID` thì reporter tự
tắt, không cố gửi.

## Phase 8 — Vòng giao dịch, chỉ số và biểu đồ NAV

`trade_outcomes` ghép bán với mua theo FIFO thành vòng trọn vẹn, tính lãi lỗ
tiền thật đã trừ phí và thuế. Không có bảng này thì không biết lệnh nào lãi
lệnh nào lỗ, nên 5 trong 6 metric không tính được và lesson scorer không bao
giờ cập nhật được confidence.

`metrics_daily` tính tỷ lệ thắng, Sharpe, sụt sâu nhất, số ngày nắm giữ trung
bình. **Sharpe dùng độ lệch chuẩn MẪU (chia n−1)**, và trả `null` khi độ lệch
bằng 0 thay vì vô cực — một agent chưa giao dịch lần nào không có Sharpe hoàn
hảo, nó không có Sharpe.

**Ngày nghỉ lễ đọc từ bảng `market_holidays`, không nhúng cứng vào code.** Lịch
nghỉ VN do Chính phủ công bố hằng năm; nhúng vào code thì từ năm sau nó sai âm
thầm. Cron `* * * * 1-5` chỉ loại được cuối tuần — nghỉ Tết rơi vào thứ Ba thì
ingest sẽ ghi lại dữ liệu phiên hôm trước với dấu thời gian hôm nay, trông tươi
nhưng không phải, và cổng `DATA_READY` sẽ cho agent giao dịch trên nó. Cách
khai lịch: xem [hướng dẫn sử dụng](docs/huong-dan-su-dung.md#5-chạy-tự-động-hằng-ngày).

**Biểu đồ NAV** trên dashboard là SVG nội tuyến, không thư viện. Trục dọc luôn
bao cả mốc vốn ban đầu — nếu chỉ lấy min/max của NAV thì một agent lãi 3% và
một agent lỗ 3% sẽ cho hai biểu đồ trông giống hệt nhau, và đường tham chiếu
biến mất khỏi khung.
