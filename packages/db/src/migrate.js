import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from './client.js';
import { loadConfig } from './config.js';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function runMigrations(client, { dir = DEFAULT_DIR } = {}) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const done = new Set(rows.map(r => r.name));

  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    await client.withTransaction(async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    applied.push(file);
    console.log(`[migrate] đã áp dụng ${file}`);
  }
  if (applied.length === 0) console.log('[migrate] không có migration mới');
  return applied;
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
