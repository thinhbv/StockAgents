#!/usr/bin/env node
/**
 * Bộ chạy test của dự án.
 *
 * Vì sao không gọi thẳng `node --test`: cách truyền tham số cho test runner
 * ĐÃ ĐỔI giữa các phiên bản Node, và đổi theo hướng loại trừ nhau.
 *
 *   Node 20 — nhận THƯ MỤC, không nhận glob.
 *             `node --test "packages/**\/*.test.js"` khớp 0 file và thoát 0.
 *   Node 22 — nhận GLOB, không nhận thư mục.
 *             `node --test packages/` báo "Cannot find module".
 *
 * Chế độ hỏng của Node 20 là loại nguy hiểm nhất: suite rỗng báo XANH. Lỗi đó
 * đã thật sự xảy ra trong dự án này một lần rồi.
 *
 * Đường dẫn FILE tường minh thì cả hai phiên bản đều nhận. Script này tự tìm
 * file, và **thoát khác 0 nếu không tìm thấy file nào** — một suite rỗng phải
 * là thất bại, không bao giờ được là thành công.
 */
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// tradingview_mcp là một git repo RIÊNG với test riêng, phần lớn cần
// TradingView Desktop đang chạy. Nó không thuộc suite của dự án này.
const SKIP_DIRS = new Set(['node_modules', '.git', 'tradingview_mcp', 'coverage']);

async function findTestFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...await findTestFiles(full));
    } else if (entry.name.endsWith('.test.js')) {
      found.push(full);
    }
  }
  return found;
}

const files = (await findTestFiles(ROOT)).sort();

if (files.length === 0) {
  console.error('run-tests: KHÔNG tìm thấy file .test.js nào — coi đây là thất bại.');
  console.error('Một suite rỗng báo xanh còn tệ hơn một suite đỏ.');
  process.exit(1);
}

console.log(`run-tests: ${files.length} file test (Node ${process.version})`);

/**
 * Chạy TỪNG FILE trong một tiến trình riêng, LẦN LƯỢT.
 *
 * Vì sao không giao cả danh sách cho `node --test --test-concurrency=1`:
 * cờ đó KHÔNG serialize thật. Đo trên Node v22.23.1 bằng log có dấu thời
 * gian và pid: giao ba file cho một lời gọi `--test --test-concurrency=1`
 * vẫn cho hai tiến trình sống chồng nhau.
 *
 * Điều đó gây hậu quả nặng ở dự án này vì mọi file test dùng CHUNG một
 * database PostgreSQL và `beforeEach` của chúng `TRUNCATE` các bảng dùng
 * chung. File A xoá `agents` giữa lúc file B đang chèn `orders` tham chiếu
 * tới nó, cho ra lỗi khoá ngoại và trùng khoá chính ở những test không hề
 * liên quan — mỗi lần chạy hỏng một bộ khác nhau.
 *
 * Chế độ hỏng này đặc biệt độc: suite thường XANH, chỉ đỏ khi máy bận hoặc
 * có tiến trình khác chạy cùng. Một suite xanh nhờ may thì không chứng minh
 * được gì cả.
 *
 * Tự lặp thì hành vi không phụ thuộc vào ngữ nghĩa cờ của từng phiên bản
 * Node — cùng lý do file này tồn tại ngay từ đầu.
 */
function runFile(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', file], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code, signal) => resolve({ file, code: signal ? 1 : (code ?? 1), signal }));
  });
}

const failed = [];
for (const file of files.map(f => relative(ROOT, f))) {
  const r = await runFile(file);
  if (r.code !== 0) failed.push(r);
}

if (failed.length > 0) {
  console.error(`\nrun-tests: ${failed.length}/${files.length} file THẤT BẠI:`);
  for (const f of failed) console.error(`  - ${f.file}${f.signal ? ` (tín hiệu ${f.signal})` : ''}`);
  process.exit(1);
}

console.log(`\nrun-tests: cả ${files.length} file đều xanh.`);
