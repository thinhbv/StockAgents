-- Chỉ số tài chính cơ bản (P/E, P/B, ROE, ROA, cổ tức, nợ/vốn chủ...) — dữ
-- liệu duy nhất hệ thống chưa từng thu thập, xem SOURCE_INDEX.md mục review
-- context. Cùng khuôn với indicator_snapshot: một bản chụp JSONB theo mã,
-- lấy bản MỚI NHẤT mỗi khi cần — báo cáo tài chính chỉ đổi theo quý nên
-- không cần lưu chuỗi lịch sử đầy đủ như ohlcv_daily.
CREATE TABLE fundamentals_snapshot (
  id          BIGSERIAL PRIMARY KEY,
  symbol      TEXT NOT NULL REFERENCES universe(symbol),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload     JSONB NOT NULL
);
CREATE INDEX fundamentals_snapshot_symbol_idx ON fundamentals_snapshot (symbol, captured_at DESC);
