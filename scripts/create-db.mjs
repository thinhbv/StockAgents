#!/usr/bin/env node
/**
 * Tạo hai database mà dự án cần, từ chính `DATABASE_URL` và
 * `DATABASE_URL_TEST` trong `.env`.
 *
 * Vì sao không bảo người dùng chạy `createdb`: trên Windows, bộ cài
 * PostgreSQL KHÔNG thêm `C:\Program Files\PostgreSQL\<ver>\bin` vào PATH,
 * nên `createdb` báo "command not found" dù PostgreSQL đang chạy ngon lành.
 * Hướng dẫn cài đặt mà bước đầu tiên đã hỏng là hướng dẫn tồi.
 *
 * Script này dùng `pg` — thư viện dự án vốn đã phụ thuộc — nên nó chạy được ở
 * bất cứ đâu Node chạy được, và dùng đúng thông tin kết nối đã khai trong
 * `.env` thay vì bắt gõ lại host/port/user một lần nữa.
 *
 * Chạy nhiều lần không sao: database đã có thì báo và bỏ qua.
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

/**
 * Tách tên database ra khỏi URL, và trả về một URL trỏ tới `postgres` —
 * database quản trị luôn tồn tại. Không thể tạo một database khi đang kết
 * nối vào chính nó.
 */
export function splitUrl(url, varName) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${varName} không phải URL hợp lệ: ${url}`);
  }

  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name === '') throw new Error(`${varName} thiếu tên database ở cuối URL`);

  const admin = new URL(url);
  admin.pathname = '/postgres';
  return { name, adminUrl: admin.href };
}

async function createIfMissing({ name, adminUrl }) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rows.length > 0) {
      console.log(`  · ${name} — đã có, bỏ qua`);
      return false;
    }
    // Tên database không tham số hoá được trong CREATE DATABASE, nên phải
    // nối chuỗi. Dùng quote_ident của chính PostgreSQL để escape cho đúng
    // thay vì tự bọc dấu nháy — tên lấy từ .env của người dùng, không phải
    // hằng số trong code.
    const { rows: [{ ident }] } = await client.query(
      'SELECT quote_ident($1) AS ident', [name]);
    await client.query(`CREATE DATABASE ${ident}`);
    console.log(`  ✓ ${name} — đã tạo`);
    return true;
  } finally {
    await client.end();
  }
}

async function main() {
  const TARGETS = [
    ['DATABASE_URL', process.env.DATABASE_URL],
    ['DATABASE_URL_TEST', process.env.DATABASE_URL_TEST],
  ];

  const missing = TARGETS.filter(([, v]) => !v || v.trim() === '').map(([k]) => k);
  if (missing.length > 0) {
    console.error(`Thiếu ${missing.join(' và ')} trong .env.`);
    console.error('Chép .env.example thành .env rồi điền mật khẩu PostgreSQL trước.');
    process.exit(1);
  }

  console.log('Tạo database:');
  try {
    for (const [varName, url] of TARGETS) {
      // .trim() vì một khoảng trắng cuối dòng trong .env sẽ lọt vào tên
      // database và cho ra lỗi "không tồn tại" rất khó đoán.
      await createIfMissing(splitUrl(url.trim(), varName));
    }
    console.log('\nXong. Bước tiếp theo: npm run migrate');
  } catch (err) {
    console.error(`\nLỗi: ${err.message}`);
    if (err.code === 'ECONNREFUSED') {
      console.error('PostgreSQL không chạy, hoặc sai host/port trong .env.');
    } else if (err.code === '28P01') {
      console.error('Sai mật khẩu trong .env.');
    }
    process.exit(1);
  }
}

// Chỉ chạy khi được gọi trực tiếp — test import `splitUrl` từ đây và không
// được vô tình tạo database thật.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
