-- Chống rung cho watchdog: một vị thế không được đánh thức quá 1 lần / 30 phút
-- cho CÙNG loại trigger. Không có bảng này, một mã dao động quanh ngưỡng
-- cắt lỗ sẽ gọi LLM mỗi 5 phút suốt phiên.
--
-- Lưu theo (agent, mã, loại) chứ không theo position_id: vị thế đóng rồi mở
-- lại trong ngày vẫn phải chịu chung nhịp chống rung.

CREATE TABLE trigger_log (
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  symbol     TEXT NOT NULL REFERENCES universe(symbol),
  type       TEXT NOT NULL,
  fired_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (agent_id, symbol, type)
);

CREATE INDEX trigger_log_agent_time_idx ON trigger_log (agent_id, fired_at DESC);
