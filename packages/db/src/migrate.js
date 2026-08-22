import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from './client.js';
import { loadConfig } from './config.js';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Số bất kỳ, chỉ cần CỐ ĐỊNH — pg_advisory_xact_lock không quan tâm ý nghĩa
// con số, chỉ dùng nó làm khoá đặt tên.
const MIGRATION_LOCK_ID = 20260822;

export async function runMigrations(client, { dir = DEFAULT_DIR } = {}) {
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();

  // Nhiều tiến trình (data-service, api, telegram-bot) đều tự chạy migration
  // lúc khởi động — nếu hai tiến trình cùng khởi động một lúc trên một DB
  // trắng, cả hai sẽ cùng đọc schema_migrations thấy "chưa áp dụng" rồi cùng
  // CREATE TABLE, một bên lỗi "relation already exists". Khoá toàn cục quanh
  // CẢ đợt (đọc CHECK + áp dụng) chặn race đó — pg_advisory_xact_lock tự nhả
  // khi transaction này COMMIT/ROLLBACK, không cần unlock tay nên không sợ
  // treo khoá nếu tiến trình crash giữa chừng.
  //
  // Gộp mọi migration còn thiếu vào MỘT transaction (không phải một transaction
  // mỗi file như trước) — DDL của Postgres transactional thật sự, nên lỗi ở
  // file thứ ba cuốn theo rollback cả file một/hai đã "thành công" trong cùng
  // lượt chạy: an toàn hơn (không bao giờ dừng lại ở trạng thái áp dụng dở
  // dang), và lần chạy lại sau khi sửa lỗi sẽ làm lại đúng những file đó từ
  // đầu, không phải giữ tiến độ nửa vời.
  return client.withTransaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);

    await tx.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await tx.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map(r => r.name));

    const applied = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
      console.log(`[migrate] đã áp dụng ${file}`);
    }
    if (applied.length === 0) console.log('[migrate] không có migration mới');
    return applied;
  });
}

// Cho phép chạy trực tiếp: npm run migrate
// Dùng pathToFileURL — so sánh chuỗi thủ công sẽ sai trên Windows
// (import.meta.url là "file:///d:/..." còn argv[1] là "d:\...").
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = loadConfig();
  const target = process.argv.includes('--test') ? cfg.databaseUrlTest : cfg.databaseUrl;
  const client = createClient(target);
  runMigrations(client)
    .then(() => client.close())
    .catch(async (err) => {
      console.error('[migrate] lỗi:', err.message);
      await client.close();
      process.exit(1);
    });
}
