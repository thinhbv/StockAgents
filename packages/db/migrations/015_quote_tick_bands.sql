-- Trần, sàn và giá tham chiếu CHÍNH THỨC của sàn, lấy từ VCI cùng lúc với giá
-- khớp. Bảng giá dùng các cột này trước, chỉ tự tính từ giá đóng cửa khi thiếu.
-- NULL với tick cũ (trước migration này) và khi VCI không trả.
ALTER TABLE quote_tick
  ADD COLUMN ceiling_price NUMERIC(20,2),
  ADD COLUMN floor_price   NUMERIC(20,2),
  ADD COLUMN ref_price     NUMERIC(20,2);
