-- Ghép lệnh mua với lệnh bán thành một vòng trọn vẹn (round-trip).
--
-- Không có bảng này thì không biết lệnh nào lãi lệnh nào lỗ, nên 5 trong 6
-- metric của spec §10 không tính được, và lesson scorer không bao giờ cập
-- nhật được confidence — cả vòng học mất một nửa ý nghĩa.

-- trade_outcomes đã tồn tại từ migration 003 nhưng chưa ai ghi vào.
-- Bổ sung các cột cần để tính metric và truy vết.
ALTER TABLE trade_outcomes
  ADD COLUMN IF NOT EXISTS symbol      TEXT,
  ADD COLUMN IF NOT EXISTS agent_id    TEXT REFERENCES agents(id),
  ADD COLUMN IF NOT EXISTS qty         INTEGER,
  ADD COLUMN IF NOT EXISTS entry_price NUMERIC(20,2),
  ADD COLUMN IF NOT EXISTS exit_price  NUMERIC(20,2),
  ADD COLUMN IF NOT EXISTS closed_at   TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS trade_outcomes_agent_idx
  ON trade_outcomes (agent_id, closed_at DESC);

-- Khớp lệnh từng phần: engine hiện khớp toàn bộ hoặc không, nhưng bảng phải
-- diễn đạt được trạng thái này trước khi Phase sau cần tới.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('PENDING', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCELLED'));

-- Ngày nghỉ lễ thị trường VN. isTradingDay chỉ biết cuối tuần, nên Tết vẫn
-- bị tính là ngày giao dịch và hệ thống sẽ ingest vào ngày sàn đóng cửa.
CREATE TABLE IF NOT EXISTS market_holidays (
  holiday_date DATE PRIMARY KEY,
  name         TEXT NOT NULL
);
