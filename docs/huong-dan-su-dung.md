# Hướng dẫn sử dụng StockAgents

Năm agent AI cùng giao dịch chứng khoán Việt Nam trên **tiền giả lập**, mỗi
agent một model và một phong cách khác nhau, để xem lối nghĩ nào hiệu quả hơn.

> **Không có tiền thật ở đâu trong hệ thống này.** Không kết nối môi giới,
> không API đặt lệnh. Mọi lệnh mua bán kết thúc ở một dòng `INSERT` vào
> PostgreSQL trên máy bạn. Kết nối ra ngoài duy nhất là tới các nhà cung cấp
> LLM, các trang tin, và Telegram.

---

## Mục lục

1. [Chuẩn bị](#1-chuẩn-bị)
2. [Cài đặt lần đầu](#2-cài-đặt-lần-đầu)
3. [Chạy thử ngay không cần API key](#3-chạy-thử-ngay-không-cần-api-key)
4. [Chạy thật với model thật](#4-chạy-thật-với-model-thật)
5. [Chạy tự động hằng ngày](#5-chạy-tự-động-hằng-ngày)
6. [Đọc dashboard](#6-đọc-dashboard)
7. [Báo cáo Telegram](#7-báo-cáo-telegram)
8. [Tuỳ biến](#8-tuỳ-biến)
9. [Kiểm tra sức khoẻ hệ thống](#9-kiểm-tra-sức-khoẻ-hệ-thống)
10. [Xử lý sự cố](#10-xử-lý-sự-cố)
11. [Những giới hạn cần biết](#11-những-giới-hạn-cần-biết)

---

## 1. Chuẩn bị

| Cần gì | Vì sao |
|---|---|
| Node.js ≥ 20.20 | Chạy toàn bộ hệ thống. Không có bước build. |
| PostgreSQL 18 | Lưu mọi thứ. Không cần pgvector. |
| TradingView Desktop | Nguồn giá. Phải bật cổng gỡ lỗi CDP 9222. |
| API key LLM (tuỳ chọn) | Chỉ cần khi muốn agent suy nghĩ thật, không cần cho chế độ `--stub`. |

**Bật CDP cho TradingView Desktop** — thoát hẳn ứng dụng rồi khởi động lại
bằng dòng lệnh:

```powershell
& "$env:LOCALAPPDATA\Programs\TradingView\TradingView.exe" --remote-debugging-port=9222
```

Kiểm tra đã bật chưa:

```bash
curl http://127.0.0.1:9222/json/version
```

Có JSON trả về là được. Không có thì mọi lệnh lấy giá sẽ báo `DATA_STALE`.

---

## 2. Cài đặt lần đầu

```bash
npm install
```

**Tạo file `.env`** từ mẫu rồi điền mật khẩu PostgreSQL của bạn:

```bash
cp .env.example .env
```

| Biến | Bắt buộc | Ý nghĩa |
|---|---|---|
| `DATABASE_URL` | ✅ | Kết nối chính, có quyền ghi. |
| `DATABASE_URL_TEST` | ✅ | **Luôn cần**, kể cả khi chỉ chạy thật — bộ nạp cấu hình đọc cả hai và báo lỗi nếu thiếu. |
| `DATABASE_URL_READONLY` | ✅ cho dashboard | Role `stockagents_ro`, chỉ `SELECT`. |
| `DASHBOARD_HOST` | | Mặc định `127.0.0.1`. |
| `DASHBOARD_PORT` | | Mặc định `8080`. |
| `DASHBOARD_TOKEN` | ⚠️ | **Bắt buộc nếu `DASHBOARD_HOST` khác localhost.** Thiếu thì server từ chối khởi động thay vì im lặng phơi dữ liệu ra mạng. |
| `DATA_STALENESS_MINUTES` | | Mặc định 90. Dữ liệu cũ hơn ngần này thì không cho giao dịch. |
| `EVENT_LOG_RETENTION_DAYS` | | Mặc định 90. |
| `ANTHROPIC_API_KEY` | | Cho `claude_value`, `claude_contrarian`. |
| `OPENAI_API_KEY` | | Cho `gpt_momentum`. |
| `GEMINI_API_KEY` | | Cho `gemini_news`. |
| `DEEPSEEK_API_KEY` | | Cho `deepseek_quant`. |
| `TELEGRAM_TOKEN` / `TELEGRAM_CHAT_ID` | | Thiếu thì báo cáo tự tắt, phiên vẫn chạy bình thường. |

**Tạo hai database** — một để chạy thật, một để chạy test. Script đọc thẳng
`DATABASE_URL` và `DATABASE_URL_TEST` bạn vừa điền, nên không phải gõ lại
host/port/user lần nữa. Chạy nhiều lần không sao, database đã có thì bỏ qua:

```bash
npm run db:create
```

> **Vì sao không dùng `createdb`:** trên Windows, bộ cài PostgreSQL không thêm
> `C:\Program Files\PostgreSQL\18\bin` vào PATH, nên `createdb` báo
> "command not found" dù PostgreSQL đang chạy bình thường. Nếu bạn vẫn muốn
> dùng công cụ dòng lệnh của PostgreSQL, phải gọi bằng đường dẫn đầy đủ:
>
> ```powershell
> & "C:\Program Files\PostgreSQL\18\bin\createdb.exe" -U postgres stockagents
> ```
>
> Hoặc thêm thư mục đó vào PATH một lần cho cả máy:
>
> ```powershell
> [Environment]::SetEnvironmentVariable('Path',
>   $env:Path + ';C:\Program Files\PostgreSQL\18\bin', 'User')
> ```
>
> Mở lại terminal thì `createdb`, `psql`, `pg_dump` mới dùng được.

Bộ test sẽ `TRUNCATE` bảng, nên nó **từ chối chạy** nếu tên database trong
`DATABASE_URL_TEST` không kết thúc bằng `_test` — một hàng rào để không bao
giờ xoá nhầm dữ liệu thật.

**Chạy migration** — tạo bảng và cả role chỉ-đọc `stockagents_ro`:

```bash
npm run migrate
```

**Kiểm tra bộ test** trước khi tin vào hệ thống:

```bash
npm test
```

Phải thấy `# pass 442`, `# fail 0`.

---

## 3. Chạy thử ngay không cần API key

Cờ `--stub` thay LLM bằng một bộ quyết định giả tất định. Không tốn token,
không cần key, và cho ra cùng một kết quả mỗi lần chạy — dùng để kiểm tra
đường ống có thông không.

**Bước 1 — lấy dữ liệu.** TradingView Desktop phải đang chạy:

```bash
npm run ingest:prices
```

Lấy 60 phiên gần nhất cho 30 mã VN30, rồi tự tính RSI, MACD, Bollinger, ATR
từ chính dữ liệu đó — 60 phiên là mức tối thiểu để MACD (26+9) có giá trị.
Mất khoảng 2–4 phút. Kết quả in ra cho biết bao nhiêu mã
thành công và trạng thái phiên là `DATA_READY`, `DATA_PARTIAL` hay `DATA_STALE`.

**Bước 2 — thu báo giá trong phiên.** Chạy trong giờ giao dịch (09:20–11:30
hoặc 13:00–14:30, thứ Hai–Sáu):

```bash
npm run poll:quotes
```

Ngoài giờ nó sẽ in "ngoài giờ giao dịch, bỏ qua" và không ghi gì — đúng như
thiết kế. Muốn có đủ tick cho một ngày mô phỏng thì chạy lặp lại nhiều lần
trong phiên, hoặc để scheduler làm (mục 5).

**Bước 3 — cho cả năm agent giao dịch trọn ngày:**

```bash
npm run sim:all -- --date 2026-08-01 --stub
```

Kết quả là một bảng xếp hạng:

```
Phiên 2026-08-01 · 42 nhịp tick · 5 agent

  #  AGENT               MODEL             NAV          LÃI/LỖ  LỆNH  ĐÁNH THỨC
   1  claude_value        stub    1.043.120.000           4.31%     3          2
   2  gpt_momentum        stub    1.011.400.000           1.14%     4          5
  ...
```

**Chạy một agent thôi** khi muốn xem kỹ:

```bash
npm run sim:day -- --agent claude_value --date 2026-08-01 --stub
```

**Chỉ chạy phiên mở cửa**, không có watchdog theo dõi cả ngày:

```bash
npm run sim:session -- --agent claude_value --date 2026-08-01 --stub
```

---

## 4. Chạy thật với model thật

Bỏ cờ `--stub`:

```bash
npm run sim:all -- --date 2026-08-01
```

Thiếu key nào, lệnh dừng ngay và **nói rõ thiếu key nào**, thay vì chạy nửa
vời rồi cho ra bảng so sánh vô nghĩa vì hai agent không thực sự chạy.

**Chi phí token tỉ lệ với số _sự kiện_, không phải số _phút_.** Agent khai
ngưỡng thoát ngay lúc mua; watchdog so sánh số học mỗi nhịp tick mà không gọi
LLM, chỉ đánh thức khi chạm ngưỡng. Cột `ĐÁNH THỨC` trong bảng cho biết chính
xác đã gọi LLM bao nhiêu lần.

**Provider chết thì agent đó bỏ lượt**, hệ thống không tự đổi sang model khác
— đổi model sẽ phá hỏng đúng phép so sánh mà hệ thống này sinh ra để làm.

---

## 5. Chạy tự động hằng ngày

```bash
npm run data-service
```

Tiến trình này giữ lịch và tự gọi mọi thứ, theo giờ Việt Nam:

| Giờ | Job | Làm gì |
|---|---|---|
| 08:30 T2–T6 | `ingest_prices` | Lấy giá và tính chỉ báo |
| 08:45 T2–T6 | `ingest_news` | Gom tin 6 nguồn VN + chỉ số thị trường |
| 09:15 T2–T6 | `run_session` | Cả 5 agent giao dịch |
| 09:00–14:55 mỗi 5 phút | `poll_quotes` | Thu báo giá (tự bỏ giờ nghỉ trưa) |
| 15:00 T2–T6 | `report_day` | Tổng kết và gửi Telegram |
| 02:00 hằng ngày | `prune_events` | Dọn nhật ký cũ |

Muốn chạy nền lâu dài thì dùng PM2 với cấu hình có sẵn:

```bash
npx pm2 start ecosystem.config.cjs
npx pm2 logs data-service
```

**Ngày nghỉ lễ:** cron chỉ loại được thứ Bảy và Chủ nhật. Nghỉ Tết rơi vào
thứ Ba thì sàn đóng nhưng cron vẫn bắn, và ingest sẽ ghi lại dữ liệu của phiên
hôm trước với dấu thời gian hôm nay — trông tươi nhưng không phải. Nên phải
tự khai lịch lễ vào bảng `market_holidays`:

```sql
INSERT INTO market_holidays (holiday_date, name) VALUES
  ('2026-01-01', 'Tết Dương lịch'),
  ('2026-04-30', 'Giải phóng miền Nam'),
  ('2026-05-01', 'Quốc tế Lao động'),
  ('2026-09-02', 'Quốc khánh')
ON CONFLICT DO NOTHING;
```

Lịch nghỉ Tết Âm lịch và các ngày nghỉ bù do Chính phủ công bố mỗi năm một
khác, nên hệ thống **cố tình không nhúng cứng** — nhúng vào code thì nó sẽ sai
âm thầm từ năm sau. Thêm vào bảng là có hiệu lực ngay, không cần khởi động lại.

---

## 6. Đọc dashboard

```bash
npm run api
```

Mở http://127.0.0.1:8080. Để nguyên tab đó rồi chạy `npm run sim:all` ở cửa sổ
khác — sự kiện hiện lên ngay, không cần F5.

### Bảng xếp hạng

Bảy cột: Agent, Model, NAV, Lãi/lỗ tổng, Lãi/lỗ hôm nay, Tiền mặt, Số vị thế.
Ô NAV **nháy sáng** khi đổi, như bảng giá thật báo có biến động.

Bấm vào một dòng để mở chi tiết agent đó.

### Màu sắc

Lấy nguyên quy ước bảng giá chứng khoán VN, để bạn không phải học lại:

| Màu | Nghĩa |
|---|---|
| 🟣 Tím | Trần / chốt lời |
| 🔵 Xanh lơ | Sàn / cắt lỗ |
| 🟡 Vàng | Tham chiếu (ở biểu đồ NAV: mốc vốn ban đầu) |
| 🟢 Xanh | Tăng |
| 🔴 Đỏ | Giảm |

### Chi tiết agent

**Đường NAV** — 90 phiên gần nhất. Đường đứt vàng nằm ngang là vốn ban đầu:
trên nó là lãi, dưới là lỗ. Trục dọc luôn bao cả mốc này, nên một agent lãi 3%
và một agent lỗ 3% không bao giờ cho ra hai biểu đồ trông giống hệt nhau.

Kèm sáu con số: NAV, lãi/lỗ, sụt sâu nhất, tỷ lệ thắng, Sharpe, số vòng giao
dịch đã đóng. Chúng đến từ `metrics_daily`, tính lại cuối mỗi phiên.

**Vị thế đang giữ** — mỗi mã có một thanh cho biết giá hiện tại đang nằm ở đâu
giữa mốc cắt lỗ và mốc chốt lời mà agent đã tự khai lúc mua. `bán được` là số
cổ phiếu đã qua T+2.5, phần còn lại vẫn đang chờ về.

**Nhật ký lý luận** — agent đã nói gì khi ra mỗi quyết định. Đây là chỗ đáng
đọc nhất: nó cho thấy model nghĩ gì, không chỉ nó làm gì.

### Dòng sự kiện

Cột bên phải, thời gian thực. `trigger.fired` cho biết vì sao một vị thế bị
đánh thức — sáu điều kiện: `TAKE_PROFIT`, `STOP_LOSS`, `TRAILING`, `TIME_STOP`,
`NEWS_ALERT`, `EOD_REVIEW`.

### Mở cho người khác xem

```bash
# .env
DASHBOARD_HOST=0.0.0.0
DASHBOARD_TOKEN=một-chuỗi-dài-ngẫu-nhiên
```

Rồi truy cập `http://<ip-máy>:8080/?token=một-chuỗi-dài-ngẫu-nhiên`. Không đặt
token thì server **từ chối khởi động** — mở ra mạng mà không có token là để ngỏ
toàn bộ lịch sử giao dịch cho bất kỳ ai.

Dashboard kết nối bằng role `stockagents_ro` chỉ có quyền `SELECT`, và mọi
phương thức khác `GET` đều trả 405. Một route viết sai vẫn không sửa được
danh mục.

---

## 7. Báo cáo Telegram

Lấy `TELEGRAM_TOKEN` từ [@BotFather](https://t.me/BotFather), lấy
`TELEGRAM_CHAT_ID` bằng cách nhắn cho bot rồi mở:

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

Gửi báo cáo tay:

```bash
npm run report:day -- --date 2026-08-01
```

Bảng xếp hạng **luôn in ra màn hình** dù Telegram có gửi được hay không —
báo cáo hỏng không được làm mất thông tin. Thiếu token thì reporter tự tắt.

---

## 8. Tuỳ biến

### Danh sách mã theo dõi

Sửa [config/universe.json](../config/universe.json). Mặc định là 30 mã VN30.
Ký hiệu phải đúng dạng TradingView (`HOSE:FPT`, `HNX:SHS`). Danh sách được nạp
lại mỗi lần `data-service` khởi động.

Càng nhiều mã thì `ingest_prices` càng lâu — TradingView chỉ có một chart, mọi
mã phải xếp hàng lần lượt.

### Tính cách và vốn của agent

Sửa [config/agents.json](../config/agents.json). Mỗi agent có:

- `personaPrompt` — mô tả phong cách, đi thẳng vào prompt hệ thống
- `initialCapital` — mặc định 1 tỷ VND
- `riskConfig` — `maxPositions`, `maxPositionPctNav`, `dailyLossLimitPct`

**Hàng rào rủi ro được cưỡng chế bằng code, ngoài tầm với của LLM:** tối đa 8
vị thế, tối đa 20% NAV cho một mã, không đòn bẩy, không bán khống, dừng giao
dịch khi lỗ trong ngày vượt 5% NAV. Agent có thuyết phục hay đến đâu cũng
không vượt qua được.

Đổi `personaPrompt` giữa chừng thì các phiên trước đó vẫn giữ nguyên trong
lịch sử — so sánh NAV qua mốc đó sẽ khập khiễng.

### Muốn thêm agent mới

Thêm một mục vào `agents.json` với `id` chưa dùng. `provider` phải là một
trong `anthropic`, `openai`, `gemini`, `deepseek`. Agent tự được tạo trong DB
ở lần chạy tiếp theo.

---

## 9. Kiểm tra sức khoẻ hệ thống

```sql
-- Dữ liệu hôm nay đã sẵn sàng chưa?
SELECT trade_date, state, data_captured_at FROM session_state
ORDER BY trade_date DESC LIMIT 5;

-- Mã nào đang lỗi khi lấy dữ liệu?
SELECT job, symbol, message, occurred_at FROM ingest_errors
WHERE occurred_at > now() - interval '1 day' ORDER BY occurred_at DESC;

-- Bảng xếp hạng hiện tại
SELECT a.name, s.nav, s.day_pnl FROM agents a
JOIN LATERAL (SELECT nav, day_pnl FROM portfolio_snapshot
              WHERE agent_id = a.id ORDER BY snap_date DESC LIMIT 1) s ON TRUE
ORDER BY s.nav DESC;

-- Các vòng mua-bán đã đóng, lãi lỗ tiền thật (đã trừ phí và thuế)
SELECT agent_id, symbol, qty, entry_price, exit_price, pnl, closed_at
FROM trade_outcomes ORDER BY closed_at DESC LIMIT 20;

-- Bài học nào đang thực sự có ích?
SELECT agent_id, lesson, confidence, times_retrieved, times_helped
FROM lessons WHERE NOT retired ORDER BY confidence DESC LIMIT 20;
```

---

## 10. Xử lý sự cố

| Triệu chứng | Nguyên nhân | Cách xử lý |
|---|---|---|
| `Thiếu biến môi trường bắt buộc: DATABASE_URL_TEST` | Bộ nạp cấu hình đọc cả hai URL kể cả khi chạy thật | Điền `DATABASE_URL_TEST` vào `.env` dù chưa định chạy test |
| `createdb: command not found` | Windows không tự thêm thư mục `bin` của PostgreSQL vào PATH | Dùng `npm run db:create`, hoặc gọi bằng đường dẫn đầy đủ (mục 2) |
| `password authentication failed for user "postgres"` | Sai mật khẩu trong `DATABASE_URL` | Sửa `.env`. Nếu vừa sửa file, nhớ lưu — tiến trình đang chạy vẫn giữ giá trị cũ cho tới khi khởi động lại |
| `chart_ready=false` hoặc `DATA_STALE` | TradingView Desktop chưa chạy, hoặc chưa bật CDP 9222 | Khởi động lại TradingView với `--remote-debugging-port=9222`, kiểm tra bằng `curl http://127.0.0.1:9222/json/version` |
| `loadApiConfig: thiếu DATABASE_URL_READONLY` | Chưa điền URL chỉ-đọc | Thêm vào `.env`; role được tạo bởi `npm run migrate` |
| Dashboard trắng, không có agent nào | Chưa chạy phiên nào | `npm run sim:all -- --date <hôm-nay> --stub` |
| Biểu đồ NAV nói "Chưa có phiên nào để vẽ" | Chưa có `portfolio_snapshot` thật (mốc 1970 không được tính) | Như trên |
| `Thiếu API key cho: openai, gemini` | Chạy thật mà thiếu key | Điền key, hoặc thêm `--stub` |
| Agent không mua gì cả | Đúng như thiết kế nếu không thấy cơ hội, hoặc dữ liệu `DATA_STALE` | Xem cột `state` trong `session_state` và nhật ký lý luận trên dashboard |
| `sim:day` báo 0 tick | Chưa có `quote_tick` cho ngày đó | Chạy `poll:quotes` trong giờ giao dịch, hoặc để scheduler chạy cả phiên |
| Agent giao dịch vào ngày nghỉ lễ | Chưa khai ngày đó vào `market_holidays` | Thêm vào bảng (mục 5) |
| Test lỗi hàng loạt | Đang trỏ vào database thật | `DATABASE_URL_TEST` phải kết thúc bằng `_test`; bộ test tự từ chối nếu không |
| Test hỏng ngẫu nhiên, mỗi lần một bộ khác, lỗi kiểu `duplicate key` hoặc `violates foreign key constraint` | Đang chạy **hai** `npm test` cùng lúc | Mọi file test dùng chung một database và `TRUNCATE` bảng dùng chung. Chỉ chạy một suite tại một thời điểm |

---

## 11. Những giới hạn cần biết

**Giả lập không phải thực tế.** Hệ thống mô phỏng T+2.5 theo từng lô, lô chẵn
100, biên độ ±7%/±10%/±15%, bước giá ba bậc, phí 0,15%, thuế bán 0,1%, trượt
giá 0,1% theo hướng bất lợi. Nhưng nó **giả định lệnh luôn khớp** ở giá đó với
khối lượng đó. Thị trường thật có thanh khoản mỏng, có lệnh không khớp hết, có
ATC hỗn loạn. Kết quả tốt ở đây không chứng minh được gì về tiền thật.

**Chỉ 30 mã VN30.** Chưa thử nghiệm với mã thanh khoản thấp, nơi giả định
"luôn khớp" sai nặng nhất.

**Chấm điểm cảm xúc tin tức bằng từ điển**, không phải bằng LLM. Nó chỉ đủ để
phân biệt "bị khởi tố" với "trúng thầu" — đủ để quyết định *có đánh thức agent
hay không*, chứ không phải một bản phân tích. Chính agent mới đọc tiêu đề và
tự đánh giá.

**RAG chạy không cần embedder.** Chưa cấu hình embedder thì bài học vẫn được
lưu và vẫn quay lại prompt, chỉ là xếp theo độ tin cậy thay vì theo ngữ nghĩa.
Đó là suy giảm êm, không phải hỏng. Muốn có tìm kiếm ngữ nghĩa thì cần API
embeddings của OpenAI hoặc Voyage — Anthropic không có.

**So sánh giữa các agent chỉ công bằng khi chúng chạy trên cùng dữ liệu.**
`sim:all` phát lại đúng một chuỗi tick cho cả năm agent vì lý do đó. Chạy từng
agent riêng vào các thời điểm khác nhau rồi so bảng xếp hạng là so nhầm.

---

## Tra cứu nhanh

```bash
npm run db:create                                 # tạo 2 database từ .env
npm run migrate                                   # tạo/cập nhật schema
npm test                                          # 442 test
npm run data-service                              # scheduler chạy nền
npm run api                                       # dashboard :8080

npm run ingest:prices                             # lấy giá + tính chỉ báo
npm run poll:quotes                               # thu báo giá trong phiên

npm run sim:all     -- --date YYYY-MM-DD [--stub] # cả 5 agent
npm run sim:day     -- --agent <id> --date YYYY-MM-DD [--stub]
npm run sim:session -- --agent <id> --date YYYY-MM-DD [--stub]
npm run report:day  -- --date YYYY-MM-DD          # tổng kết + Telegram
```

Chi tiết kiến trúc và lý do đằng sau từng quyết định thiết kế:
[docs/superpowers/specs/2026-07-26-ai-trading-agents-design.md](superpowers/specs/2026-07-26-ai-trading-agents-design.md)
và [README.md](../README.md).
