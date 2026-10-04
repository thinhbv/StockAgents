CREATE TABLE llm_usage (
  id                 BIGSERIAL PRIMARY KEY,
  agent_id           TEXT NOT NULL REFERENCES agents(id),
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  -- 'decision' = lượt ra quyết định giao dịch (runner.js), 'reflect' = lượt
  -- rút bài học cuối phiên (learning/reflect.js) — hai loại lệch nhau nhiều
  -- về kích thước prompt, gộp chung sẽ làm trung bình mất nghĩa.
  purpose            TEXT NOT NULL CHECK (purpose IN ('decision', 'reflect')),
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  -- Token đọc/ghi cache — hầu hết provider hiện tại luôn trả 0 vì chưa bật
  -- cache_control (xem packages/agent-runtime/src/llm/*.js), nhưng cột có
  -- sẵn để không phải thêm migration nữa khi bật cache sau này.
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  succeeded          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX llm_usage_agent_created_idx ON llm_usage (agent_id, created_at DESC);
CREATE INDEX llm_usage_created_idx ON llm_usage (created_at DESC);
