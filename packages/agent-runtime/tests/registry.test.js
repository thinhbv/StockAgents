import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentDefs } from '../src/agents/registry.js';

const BASE = { id: 'a1', name: 'A1', provider: 'stub', model: 'stub', initialCapital: 1_000_000_000 };

// Dựng một thư mục config tạm: agents.json cùng các file phụ bên cạnh.
async function withConfig(agents, files, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'registry-test-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content, 'utf8');
    }
    const cfg = join(dir, 'agents.json');
    await writeFile(cfg, JSON.stringify(agents), 'utf8');
    return await fn(cfg);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('personaPrompt là file .md thì nội dung được đọc vào, bỏ khoảng trắng đầu cuối', async () => {
  await withConfig(
    [{ ...BASE, personaPrompt: 'persona.md' }],
    { 'persona.md': '  Bạn là nhà đầu tư kiên nhẫn. Giá tính bằng VND.\n\n' },
    async (cfg) => {
      const [d] = await loadAgentDefs(cfg);
      assert.equal(d.personaPrompt, 'Bạn là nhà đầu tư kiên nhẫn. Giá tính bằng VND.');
    });
});

test('personaPrompt là chuỗi thường thì giữ nguyên (tương thích ngược)', async () => {
  await withConfig(
    [{ ...BASE, personaPrompt: 'Bạn là nhà đầu tư. Giá tính bằng VND.' }],
    {},
    async (cfg) => {
      const [d] = await loadAgentDefs(cfg);
      assert.equal(d.personaPrompt, 'Bạn là nhà đầu tư. Giá tính bằng VND.');
    });
});

test('file .md không tồn tại thì báo lỗi kèm id agent và tên file', async () => {
  await withConfig(
    [{ ...BASE, personaPrompt: 'thieu.md' }],
    {},
    async (cfg) => {
      await assert.rejects(() => loadAgentDefs(cfg), /a1.*thieu\.md/);
    });
});

test('file .md trống thì báo lỗi, không nạp persona rỗng', async () => {
  await withConfig(
    [{ ...BASE, personaPrompt: 'trong.md' }],
    { 'trong.md': '  \n' },
    async (cfg) => {
      await assert.rejects(() => loadAgentDefs(cfg), /a1.*trống/);
    });
});
