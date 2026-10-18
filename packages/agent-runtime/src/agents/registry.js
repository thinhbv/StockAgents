import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATH = new URL('../../../../config/agents.json', import.meta.url);

// personaPrompt có thể là chuỗi tính cách viết thẳng trong JSON, hoặc đường
// dẫn một file .md — đường dẫn tính tương đối với thư mục chứa agents.json
// (ví dụ "persona.md"). File được đọc lại mỗi lần nạp, nên sửa md có hiệu lực
// ở lượt chạy kế tiếp mà không phải đổi JSON.
const PERSONA_FILE = /\.md$/;

export async function loadAgentDefs(path = DEFAULT_PATH) {
  const configFile = path instanceof URL ? fileURLToPath(path) : path;
  const raw = await readFile(configFile, 'utf8');
  const defs = JSON.parse(raw);
  if (!Array.isArray(defs) || defs.length === 0) {
    throw new Error('loadAgentDefs: config/agents.json phải là mảng không rỗng');
  }
  for (const d of defs) {
    for (const key of ['id', 'name', 'provider', 'model', 'personaPrompt', 'initialCapital']) {
      if (d[key] === undefined) {
        throw new Error(`loadAgentDefs: agent '${d.id ?? '?'}' thiếu trường '${key}'`);
      }
    }
    if (PERSONA_FILE.test(d.personaPrompt)) {
      d.personaPrompt = await readPersona(configFile, d);
    }
  }
  return defs;
}

async function readPersona(configFile, def) {
  const file = resolve(dirname(configFile), def.personaPrompt);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new Error(
      `loadAgentDefs: agent '${def.id}' trỏ tới personaPrompt '${def.personaPrompt}' ` +
      `nhưng không đọc được file: ${err.message}`);
  }
  if (text.trim() === '') {
    throw new Error(`loadAgentDefs: agent '${def.id}' có personaPrompt '${def.personaPrompt}' nhưng file trống`);
  }
  return text.trim();
}
