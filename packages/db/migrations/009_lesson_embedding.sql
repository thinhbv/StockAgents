-- Embedding lưu dạng JSONB thay vì kiểu vector của pgvector.
--
-- Lý do: PostgreSQL 18 trên máy chưa có pgvector, và ở quy mô vài trăm lesson
-- mỗi agent thì cosine similarity tính trong Node nhanh hơn nhiều so với chi
-- phí vận hành thêm một extension. Khi số lesson vượt vài nghìn, chuyển sang
-- pgvector chỉ cần đổi cột và hàm topK — phần còn lại của hệ thống không đổi.

ALTER TABLE lessons     ADD COLUMN embedding JSONB;
ALTER TABLE news_items  ADD COLUMN embedding JSONB;

-- Kết quả round-trip của một lệnh: cần để biết bài học có giúp được không.
ALTER TABLE lesson_usage
  ADD COLUMN recorded_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX lesson_usage_trade_idx ON lesson_usage (trade_id);
