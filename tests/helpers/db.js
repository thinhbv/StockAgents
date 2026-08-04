import { createClient } from '../../packages/db/src/client.js';
import { runMigrations } from '../../packages/db/src/migrate.js';
import { loadConfig } from '../../packages/db/src/config.js';

/**
 * DB thật và DB test nằm CÙNG một server, chỉ khác nhau hậu tố `_test`. Test
 * helper này TRUNCATE/DROP không điều kiện — một lỗi gõ nhầm trong .env trỏ
 * DATABASE_URL_TEST vào DB thật thì DB thật bị xóa, và không bài test nào bắt
 * được việc đó vì thiệt hại CHÍNH LÀ lần chạy test. Chặn ở nguồn: từ chối bất
 * kỳ connection string nào không kết thúc bằng `_test`.
 */
function assertTestDatabase(connectionString) {
  const dbName = new URL(connectionString).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `withTestDb: từ chối kết nối tới database '${dbName}' — tên phải kết thúc ` +
      `bằng '_test' để tránh test TRUNCATE/DROP nhầm vào database thật.`);
  }
}

export async function withTestDb() {
  const cfg = loadConfig();
  assertTestDatabase(cfg.databaseUrlTest);
  const client = createClient(cfg.databaseUrlTest);
  await runMigrations(client);
  return client;
}

export async function resetTables(client, names) {
  if (names.length === 0) return;
  await client.query(`TRUNCATE ${names.join(', ')} RESTART IDENTITY CASCADE`);
}
