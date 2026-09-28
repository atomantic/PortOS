import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { query } from '../lib/db.js';
import { createPgFileFacade, resolvePgBackend } from '../lib/pgFileFacade.js';
import { atomicWrite, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

export const mediaPromptHistoryEvents = new EventEmitter();

const queueWrite = createFileWriteQueue();
const file = () => join(PATHS.data, 'media-prompt-examinations.json');
const read = () => readJSONFile(file(), [], { allowArray: true, strict: true });
const store = createPgFileFacade({
  makeFile: () => ({
    save: (record) => queueWrite(async () => {
      const records = await read();
      await atomicWrite(file(), [record, ...records]);
    }),
    list: async (offset) => (await read()).slice(offset, offset + 21),
    get: async (id) => (await read()).find((record) => record.id === id),
  }),
  makePg: () => resolvePgBackend({
    requirement: 'PostgreSQL is required for media prompt history',
    loadDb: () => import('../lib/db.js'),
    makePg: () => ({
      save: (record) => query('INSERT INTO media_prompt_examinations (id, source_key, data, created_at) VALUES ($1, $2, $3, $4)',
        [record.id, JSON.stringify(record.source), record, record.createdAt]),
      list: async (offset) => (await query('SELECT data FROM media_prompt_examinations ORDER BY created_at DESC, id DESC LIMIT 21 OFFSET $1', [offset])).rows.map((row) => row.data),
      get: async (id) => (await query('SELECT data FROM media_prompt_examinations WHERE id = $1', [id])).rows[0]?.data,
    }),
  }),
});

export async function saveMediaPromptExamination(source, result) {
  const record = { id: randomUUID(), createdAt: new Date().toISOString(), source, result };
  await (await store.getBackend()).save(record);
  mediaPromptHistoryEvents.emit('changed');
  return record;
}

export async function listMediaPromptExaminations(offset = 0) {
  const rows = await (await store.getBackend()).list(offset);
  return { items: rows.slice(0, 20).map(({ id, createdAt, source }) => ({ id, createdAt, source })), hasMore: rows.length > 20 };
}

export async function getMediaPromptExamination(id) {
  return (await store.getBackend()).get(id);
}
