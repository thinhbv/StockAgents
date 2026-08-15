# Thiết kế database

Tài liệu này mô tả **schema thật đang chạy** (10 migration, `packages/db/migrations/002`
→ `011`), không phải bản thiết kế sơ khai trong
[ai_trading_system.md](ai_trading_system.md#5-database-schema). Dùng file này để
tra cứu khi cần biết một bảng dùng để làm gì, ai ghi vào nó, và vì sao nó có
hình dạng như vậy.

Mọi bảng nằm trong 1 database (`DATABASE_URL`). Vai trò `stockagents_ro`
(migration 008) chỉ có quyền `SELECT` trên toàn bộ schema — dashboard
(`packages/api`) kết nối bằng vai trò này, không route nào của nó ghi được.

## Bốn nhóm bảng

```
 universe ──< ohlcv_daily            (giá theo ngày)
          ──< quote_tick             (giá theo tick)
          ──< indicator_snapshot     (chỉ báo KT)

 agents   ──< orders ──< fills                (đặt lệnh → khớp lệnh)
          ──< positions ──< position_lots     (đang giữ → lô mua, luật T+2.5)
          ──< trades ──o trade_outcomes       (đã quyết định → vòng lãi/lỗ)
          ──< lessons ──< lesson_usage        (bài học riêng → lần dùng lại)
          ──< portfolio_snapshot              (NAV theo ngày)
          ──< metrics_daily                   (chỉ số theo ngày)

 ký hiệu: A ──< B  = một A có nhiều B (1-n)
          A ──o B  = một A có tối đa một B (1-0..1)
```

| Nhóm | Bảng | Ai ghi |
|---|---|---|
| **Thị trường** | `universe`, `ohlcv_daily`, `indicator_snapshot`, `quote_tick`, `market_index_snapshot`, `session_state`, `ingest_errors`, `market_holidays` | `data-service` |
| **Giao dịch** | `agents`, `orders`, `fills`, `positions`, `position_lots`, `trades`, `trade_outcomes`, `portfolio_snapshot`, `metrics_daily` | `agent-runtime` (engine/orchestrator) |
| **Trí nhớ & sự kiện** | `news_items`, `lessons`, `lesson_usage`, `event_log` | `data-service` (news) + `agent-runtime` (lessons, events) |
| **Vận hành watchdog** | `trigger_log` | `agent-runtime` (watchdog) |

---

## 1. Nhóm thị trường

### `universe`
Danh sách mã theo dõi — nguồn của mọi `FOREIGN KEY (symbol)` trong hệ thống.

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `symbol` | TEXT PK | Dạng TradingView, vd `HOSE:FPT` |
| `exchange` | TEXT | HOSE/HNX |
| `sector` | TEXT | Ngành — đưa vào context cho agent |
| `active` | BOOLEAN | Mã tắt (active=false) vẫn giữ lại lịch sử, chỉ ngừng ingest mới |

Nạp lại từ [config/universe.json](../config/universe.json) mỗi lần `data-service` khởi động.

### `ohlcv_daily`
Giá đóng cửa theo **ngày** — 60 phiên gần nhất mỗi mã, dùng để tính chỉ báo và
làm `refPriceMap` (giá tham chiếu, biên độ ±7%/±10%/±15%).

PK ghép `(symbol, trade_date)` — `ON CONFLICT` khi ingest lại cùng ngày thì
ghi đè, không nhân đôi.

### `indicator_snapshot`
RSI/MACD/Bollinger/ATR **tự tính từ `ohlcv_daily`** (không đọc trực tiếp từ
TradingView — xem README phần "Chỉ báo tự tính"). `payload` là JSONB thay vì
cột riêng từng chỉ báo vì bộ chỉ báo có thể đổi mà không cần migration.

### `quote_tick`
Giá **trong phiên**, ghi mỗi 5 phút bởi `poll_quotes`. Đây là bảng lớn nhất
theo số dòng (30 mã × ~66 tick/phiên × mọi ngày). `DISTINCT ON (symbol) ...
ORDER BY ts DESC` là câu lệnh lấy "giá mới nhất" dùng khắp hệ thống.

### `market_index_snapshot`
VNINDEX và các chỉ số khác — bối cảnh vĩ mô đưa vào prompt agent, không gắn
với mã cụ thể nên không có FK tới `universe`.

### `session_state`
Máy trạng thái `DATA_READY` / `DATA_PARTIAL` / `DATA_STALE` theo từng ngày —
**cổng duy nhất** quyết định agent có được mở phiên hay không. PK là chính
`trade_date`, mỗi ngày một dòng, `UPSERT` khi ingest chạy lại.

### `ingest_errors` / `market_holidays`
Nhật ký lỗi thu thập dữ liệu, và lịch nghỉ lễ VN (migration 010) — không
nhúng cứng vào code vì Chính phủ công bố lịch nghỉ mỗi năm một khác.

---

## 2. Nhóm giao dịch — trái tim của simulation

### `agents`
Định nghĩa + trạng thái sống của từng agent. `persona_prompt`, `risk_config`
đồng bộ từ [config/agents.json](../config/agents.json) mỗi lần chạy
(`UPSERT ... ON CONFLICT (id) DO UPDATE`). `cash_vnd` (migration 006) là
**tiền mặt hiện tại** — tách khỏi `portfolio_snapshot` vì snapshot là lịch sử,
lẫn lộn hai thứ sẽ làm hỏng phép tính lãi/lỗ trong ngày.

### `orders` → `fills`
Vòng đời một lệnh: `orders` ghi **ý định** (kể cả lệnh bị từ chối, kèm
`reject_reason` — dữ liệu học, không phải sự cố), `fills` ghi **kết quả khớp
thật** (có thể nhiều dòng nếu khớp từng phần).

`fills` không có `agent_id` gốc (Phase 1) — migration 005 thêm cột này **và**
một trigger Postgres (`fills_agent_matches_order_trg`) buộc `fills.agent_id`
luôn khớp `orders.agent_id`. Đây là ví dụ cưỡng chế bất biến ở tầng DB thay vì
tin tưởng code tầng trên luôn `JOIN` đúng.

### `positions` + `position_lots`
`positions` là vị thế **đang mở** — unique index
`(agent_id, symbol) WHERE closed_at IS NULL` đảm bảo một agent chỉ có tối đa
1 vị thế mở cho 1 mã tại một thời điểm. `exit_plan` (JSONB) chứa
`stopLossPct`/`takeProfitPct`/`trailingPct`/`timeStopDays` do agent tự khai —
watchdog đọc từ đây để tự bán hoặc đánh thức (xem
[watchdog.js](../packages/agent-runtime/src/orchestrator/watchdog.js)).

`position_lots` tách riêng vì luật **T+2.5**: mỗi lần mua thêm tạo một lô mới
với `sellable_from` riêng — `qty_sellable` trên `positions` là tổng các lô đã
tới ngày, `qty_total` luôn ≥ `qty_sellable`.

### `trades`
**Nhật ký lý luận** — mỗi quyết định BUY/SELL, kèm `reason` (bắt buộc, kể cả
lệnh máy móc tự cắt lỗ) và `confidence` (0..1, thang điểm chung để so sánh
5 agent). `trigger` ghi loại trigger đã gây ra lệnh (`STOP_LOSS`,
`TAKE_PROFIT`...) hoặc null nếu agent tự quyết không do trigger nào. Dashboard
đọc thẳng bảng này cho phần "Nhật ký lý luận".

### `trade_outcomes`
Ghép mua–bán theo FIFO thành **vòng trọn vẹn** (round-trip) — migration 010
bổ sung `symbol`/`agent_id`/`qty`/`entry_price`/`exit_price` vì bảng tồn tại
từ 003 nhưng chưa ai ghi. Không có bảng này thì không biết lệnh nào lãi lệnh
nào lỗ, 5/6 metric ở `metrics_daily` không tính được, và lesson scorer không
bao giờ cập nhật được `confidence`.

### `portfolio_snapshot` / `metrics_daily`
`portfolio_snapshot`: NAV/tiền mặt/lãi-lỗ mỗi ngày, PK `(agent_id, snap_date)`
— vẽ biểu đồ NAV trên dashboard. `metrics_daily`: win rate, Sharpe (độ lệch
chuẩn **mẫu**, chia n−1), max drawdown, số vòng giao dịch — tính lại cuối mỗi
phiên. `confidence_calibration` (migration 011) đo agent có **tự tin đúng
lúc** không: chênh lệch confidence trung bình giữa vòng thắng và vòng thua,
dương là tốt.

---

## 3. Nhóm trí nhớ & sự kiện

### `news_items`
Tin tức 6 nguồn VN, chấm `sentiment` bằng từ điển (không dùng LLM — xem README
Phase 7). `embedding` (JSONB, migration 009) phục vụ RAG khi có API key
embeddings; thiếu thì cột này để `NULL`, hệ thống suy giảm êm sang xếp hạng
theo độ tin cậy.

### `lessons` + `lesson_usage`
Bài học agent tự rút sau mỗi phiên, `confidence` cập nhật theo kết quả round
trip dùng lại nó (Laplace smoothing — trúng 1 lần không nhảy lên 1.0).
`retired = TRUE` khi điểm dưới 0.3 **và** đã thử ≥10 lần — chặn `lessons`
phình thành mê tín. `lesson_usage` là log mỗi lần một bài học được lấy ra
dùng cho một `trade`, để biết `times_helped`/`times_retrieved`.

### `event_log`
Mọi sự kiện realtime cho dashboard SSE — tên `type` là hợp đồng, xem
[events.js](../packages/agent-runtime/src/orchestrator/events.js). Không có
`FOREIGN KEY` cứng ngoài `agent_id`; `payload` JSONB linh hoạt theo từng loại
sự kiện. `session.state` (một trong các `type`) mang cả `tradeDate` trong
payload — **không suy ra ngày từ `ts`**, vì `ts` là giờ ghi THẬT còn
`tradeDate` là ngày mô phỏng, hai cái có thể khác nhau khi chạy bù/chạy lại.

---

## 4. Vận hành watchdog

### `trigger_log`
Chống rung: một `(agent, mã, loại trigger)` không được đánh thức quá 1
lần/30 phút. PK ghép `(agent_id, symbol, type)` nên mỗi tổ hợp chỉ có 1 dòng
"lần nổ gần nhất", không phải log đầy đủ (đó là việc của `event_log`).

---

## Vài quy ước xuyên suốt

- **Giá luôn là `NUMERIC(20,2)` tính bằng VND**, không phải nghìn đồng —
  `PRICE_SCALE=1`, xem README phần "Đơn vị giá".
- **JSONB cho phần dễ đổi** (`payload`, `exit_plan`, `risk_config`,
  `embedding`) — tránh migration mỗi khi thêm một trường nhỏ, đổi lại mất
  ràng buộc kiểu ở tầng DB cho riêng phần đó.
- **`ON DELETE CASCADE` chỉ ở quan hệ sở hữu chặt** (`position_lots` →
  `positions`, `lesson_usage` → `lessons`) — các FK còn lại cố ý KHÔNG cascade,
  xoá nhầm `agents`/`universe` sẽ báo lỗi thay vì âm thầm xoá theo dây chuyền.
- **Không dùng pgvector** — xem lý do ở migration 009 và README Phase 6.
