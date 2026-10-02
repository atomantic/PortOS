import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHealth, close, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { migrate } from './migrateMemoryToPg.js';

// This replacement workflow necessarily owns the whole memory table. The DB
// config serializes suites and db.js refuses runner writes outside a test DB.
const health = await checkHealth();
const runDb = requireDbOrSkip('scripts/migrateMemoryToPg.db.test', health.connected && health.hasSchema, health.error || 'memory schema unavailable');
const oldA = '00000000-0000-4000-8000-000000000010';
const oldB = '00000000-0000-4000-8000-000000000011';
const newA = '00000000-0000-4000-8000-000000000020';
const newB = '00000000-0000-4000-8000-000000000021';
const missing = '00000000-0000-4000-8000-000000000099';
let dir;

const snapshot = async () => ({
  memories: (await query('SELECT * FROM memories ORDER BY id')).rows,
  links: (await query('SELECT * FROM memory_links ORDER BY source_id, target_id')).rows,
});

async function writeSource(records) {
  await writeFile(join(dir, 'index.json'), JSON.stringify({ memories: records.map(({ id, type }) => ({ id, type })) }));
  for (const record of records) {
    await mkdir(join(dir, 'memories', record.id), { recursive: true });
    await writeFile(join(dir, 'memories', record.id, 'memory.json'), JSON.stringify(record));
  }
}

const records = () => [
  { id: newA, type: 'fact', content: 'First replacement', relatedMemories: [newB] },
  { id: newB, type: 'fact', content: 'Forward target', relatedMemories: [] },
];

afterAll(() => close());

describe.skipIf(!runDb)('atomic memory migration in PostgreSQL', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memory-migration-db-'));
    await query('DELETE FROM memories');
    await query("INSERT INTO memories (id, type, content) VALUES ($1, 'fact', 'Previous first'), ($2, 'fact', 'Previous second')", [oldA, oldB]);
    await query('INSERT INTO memory_links (source_id, target_id) VALUES ($1, $2)', [oldA, oldB]);
  });

  afterEach(async () => {
    await query('DELETE FROM memories');
    await rm(dir, { recursive: true, force: true });
  });

  it.each(['malformed source', 'record constraint', 'link constraint'])('preserves the previous graph on %s failure', async failure => {
    const source = records();
    if (failure === 'record constraint') source[1].content = null;
    if (failure === 'link constraint') source[0].relatedMemories = [missing];
    await writeSource(source);
    if (failure === 'malformed source') await writeFile(join(dir, 'memories', newB, 'memory.json'), '{ malformed');
    const before = await snapshot();

    const error = await migrate({ memoryDir: dir, execute: true, clearFirst: true }).then(() => null, err => err);
    // Persisted state is the rollback contract, independent of SQL-call mocks.
    expect(await snapshot()).toEqual(before);
    expect(error).toBeInstanceOf(Error);
    if (failure === 'record constraint') expect(error.code).toBe('23502');
    if (failure === 'link constraint') expect(error.code).toBe('23503');
    if (failure === 'malformed source') expect(error).toBeInstanceOf(SyntaxError);
  });

  it('replaces the graph with forward links, then replays without overwriting records', async () => {
    await writeSource(records());
    expect(await migrate({ memoryDir: dir, execute: true, clearFirst: true })).toEqual({ inserted: 2, skipped: 0, links: 1, total: 2 });
    const imported = await snapshot();
    expect(imported.memories.map(({ id, content }) => ({ id, content }))).toEqual([
      { id: newA, content: 'First replacement' }, { id: newB, content: 'Forward target' },
    ]);
    expect(imported.links.map(({ source_id, target_id }) => [source_id, target_id])).toEqual([[newA, newB]]);
    const replay = records();
    replay[0].content = null; // An incomplete replay must still skip the stored record.
    await writeSource(replay);
    expect(await migrate({ memoryDir: dir, execute: true })).toEqual({ inserted: 0, skipped: 2, links: 0, total: 2 });
    expect(await snapshot()).toEqual(imported);
  });
});
