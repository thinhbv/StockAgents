-- Tiền mặt hiện tại là TRẠNG THÁI, còn portfolio_snapshot là LỊCH SỬ.
-- Ban đầu Phase 2 nhét tiền mặt vào snapshot mới nhất để khỏi thêm cột, nhưng
-- như vậy mỗi lệnh mua lại ghi đè chính snapshot mốc dùng làm chuẩn so sánh
-- PnL ngày — khiến "lãi/lỗ trong ngày" biến thành một con số vô nghĩa.
--
-- Tách hẳn: agents.cash_vnd giữ tiền mặt hiện tại, snapshot chỉ để đọc lịch sử.

ALTER TABLE agents
  ADD COLUMN cash_vnd NUMERIC(20,2) NOT NULL DEFAULT 0
  CHECK (cash_vnd >= 0);

-- Agent đã tồn tại thì khởi tạo tiền mặt bằng vốn ban đầu.
UPDATE agents SET cash_vnd = initial_capital WHERE cash_vnd = 0;
