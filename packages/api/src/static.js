import { readFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export async function serveStatic(rootDir, urlPath) {
  const root = resolve(rootDir);

  // Giải mã TRƯỚC khi kiểm tra: '%2e%2e%2f' cũng là '../'.
  let decoded;
  try { decoded = decodeURIComponent(urlPath); }
  catch { return { status: 400, headers: {}, body: 'đường dẫn không hợp lệ' }; }

  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = resolve(join(root, rel));

  // Sau khi giải quyết mọi '..', file PHẢI còn nằm trong thư mục public.
  if (!target.startsWith(root)) {
    return { status: 403, headers: {}, body: 'cấm truy cập ngoài thư mục public' };
  }

  try {
    const body = await readFile(target);
    return {
      status: 200,
      headers: { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' },
      body,
    };
  } catch {
    return { status: 404, headers: {}, body: 'không tìm thấy' };
  }
}
