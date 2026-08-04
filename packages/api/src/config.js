import 'dotenv/config';

export function loadApiConfig(env = process.env) {
  const readonlyUrl = env.DATABASE_URL_READONLY;
  if (!readonlyUrl || readonlyUrl.trim() === '') {
    throw new Error(
      'loadApiConfig: thiếu DATABASE_URL_READONLY. Dashboard phải kết nối bằng ' +
      'role chỉ có quyền SELECT — xem migration 008_readonly_role.sql.');
  }

  const host = env.DASHBOARD_HOST ?? '127.0.0.1';
  const token = env.DASHBOARD_TOKEN ?? '';

  // Mở ra ngoài localhost mà không có token là để ngỏ toàn bộ lịch sử giao
  // dịch cho bất kỳ ai trong mạng. Chặn ở cấu hình, không phải ở tài liệu.
  if (host !== '127.0.0.1' && host !== 'localhost' && token.trim() === '') {
    throw new Error(
      `loadApiConfig: DASHBOARD_HOST='${host}' mở ra ngoài localhost nhưng ` +
      'DASHBOARD_TOKEN rỗng. Đặt token, hoặc để host là 127.0.0.1.');
  }

  return { host, port: Number(env.DASHBOARD_PORT ?? 8080), token: token.trim(), readonlyUrl };
}
