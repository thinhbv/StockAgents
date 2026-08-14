-- Mọi agent đã bắt buộc phải khai confidence 0..1 trên mỗi quyết định
-- (decision_schema.js) từ trước, nhưng con số đó chưa từng được tổng hợp lại
-- để so sánh giữa 5 agent — win rate/Sharpe chỉ nói agent nào lãi, không nói
-- agent nào TỰ TIN ĐÚNG LÚC. Cột này lưu chênh lệch confidence trung bình
-- giữa vòng thắng và vòng thua; xem sim/metrics.js::confidenceCalibration.
ALTER TABLE metrics_daily
  ADD COLUMN IF NOT EXISTS confidence_calibration NUMERIC(6,4);
