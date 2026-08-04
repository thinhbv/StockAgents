import 'dotenv/config';

function required(env, key) {
  const value = env[key];
  if (!value || String(value).trim() === '') {
    throw new Error(`Thiếu biến môi trường bắt buộc: ${key}`);
  }
  return String(value).trim();
}

function numberWithDefault(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Biến môi trường ${key} phải là số, nhận được: ${raw}`);
  }
  return value;
}

function boolWithDefault(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  return ['1', 'true', 'yes'].includes(String(raw).trim().toLowerCase());
}

export function loadConfig(env = process.env) {
  return Object.freeze({
    databaseUrl: required(env, 'DATABASE_URL'),
    databaseUrlTest: required(env, 'DATABASE_URL_TEST'),
    dataStalenessMinutes: numberWithDefault(env, 'DATA_STALENESS_MINUTES', 90),
    eventLogRetentionDays: numberWithDefault(env, 'EVENT_LOG_RETENTION_DAYS', 90),
    // Cho phiên tự động chạy hằng ngày (job run_session trong data-service)
    // dùng provider giả lập thay vì gọi API thật — bật khi chưa có đủ API
    // key cho mọi provider, tắt (xoá biến hoặc để false) khi sẵn sàng chạy thật.
    simStub: boolWithDefault(env, 'SIM_STUB', false),
    tz: 'Asia/Ho_Chi_Minh',
  });
}
