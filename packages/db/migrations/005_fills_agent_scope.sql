-- fills là bảng giao dịch DUY NHẤT không mang agent_id: nó chỉ tới được
-- qua order_id -> orders.agent_id. Nghĩa là assertAgentScope() không bảo vệ
-- được nó, và tính cô lập giữa các agent phải dựa vào việc người viết code
-- NHỚ join qua orders — tức cô lập bằng quy ước, đúng thứ nguyên tắc §3.2
-- của spec cấm.
--
-- Simulation Engine ở Phase 2 sẽ ghi trực tiếp vào bảng này, nên sửa trước
-- khi có code phụ thuộc vào hình dạng cũ.
--
-- Bảng đang rỗng (chưa có gì ghi vào fills ở Phase 1) nên thêm NOT NULL
-- trực tiếp được, không cần backfill.

ALTER TABLE fills
  ADD COLUMN agent_id TEXT NOT NULL REFERENCES agents(id);

CREATE INDEX fills_agent_idx ON fills (agent_id, filled_at DESC);

-- agent_id trên fills phải luôn khớp với agent_id của order cha.
-- Ràng buộc này chặn việc ghi lệch — thứ mà tầng ứng dụng có thể làm sai
-- âm thầm khi Phase 2 dựng khớp lệnh từng phần.
CREATE OR REPLACE FUNCTION fills_agent_matches_order() RETURNS TRIGGER AS $$
DECLARE
  order_agent TEXT;
BEGIN
  SELECT agent_id INTO order_agent FROM orders WHERE id = NEW.order_id;
  IF order_agent IS DISTINCT FROM NEW.agent_id THEN
    RAISE EXCEPTION
      'fills.agent_id (%) không khớp orders.agent_id (%) cho order_id %',
      NEW.agent_id, order_agent, NEW.order_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fills_agent_matches_order_trg
  BEFORE INSERT OR UPDATE ON fills
  FOR EACH ROW EXECUTE FUNCTION fills_agent_matches_order();
