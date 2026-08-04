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

export function loadConfig(env = process.env) {
  return Object.freeze({
    databaseUrl: required(env, 'DATABASE_URL'),
    databaseUrlTest: required(env, 'DATABASE_URL_TEST'),
    dataStalenessMinutes: numberWithDefault(env, 'DATA_STALENESS_MINUTES', 90),
    eventLogRetentionDays: numberWithDefault(env, 'EVENT_LOG_RETENTION_DAYS', 90),
    tz: 'Asia/Ho_Chi_Minh',
  });
}
