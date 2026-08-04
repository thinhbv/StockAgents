import { readFile } from 'node:fs/promises';

const DEFAULT_PATH = new URL('../../../../config/agents.json', import.meta.url);

export async function loadAgentDefs(path = DEFAULT_PATH) {
  const raw = await readFile(path, 'utf8');
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
  }
  return defs;
}
