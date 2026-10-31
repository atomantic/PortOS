import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { up } from './025-drop-replicated-brain-bridge-memories.js';

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('db-migrations/025-drop-replicated-brain-bridge-memories.db.test', health.connected, 'disposable PostgreSQL unavailable');

const LOCAL = '00000000-0000-4000-8000-0000000000aa';
const PEER = '00000000-0000-4000-8000-0000000000bb';
const rows = {
  foreignUnlinked: { agent: 'brain-bridge', origin: PEER },
  foreignLinked: { agent: 'brain-bridge', origin: PEER, linked: true },
  localOrigin: { agent: 'brain-bridge', origin: LOCAL },
  unknownOrigin: { agent: 'brain-bridge', origin: 'unknown' },
  nullOrigin: { agent: 'brain-bridge', origin: null },
  foreignNonBridge: { agent: 'cos-agent', origin: PEER },
};
const ids = Object.fromEntries(Object.keys(rows).map((name) => [name, randomUUID()]));
const linkKey = `test:${randomUUID()}`;

afterAll(async () => {
  if (runDb) {
    await query('DELETE FROM memories WHERE id = ANY($1::uuid[])', [Object.values(ids)]);
    await query('DELETE FROM brain_memory_links WHERE bridge_key = $1', [linkKey]);
    await close();
  }
});

describe.skipIf(!runDb)('migration 025 replicated brain-bridge repair', () => {
  it('removes only foreign, unlinked bridged copies', async () => {
    for (const [name, row] of Object.entries(rows)) {
      await query(`INSERT INTO memories (id, type, content, summary, category, source_agent_id, origin_instance_id)
        VALUES ($1, 'fact', 'Example content', 'Example', 'other', $2, $3)`, [ids[name], row.agent, row.origin]);
      if (row.linked) await query('INSERT INTO brain_memory_links (bridge_key, memory_id) VALUES ($1, $2)', [linkKey, ids[name]]);
    }
    await withTransaction((client) => up(client, async () => LOCAL));
    const { rows: kept } = await query('SELECT id FROM memories WHERE id = ANY($1::uuid[])', [Object.values(ids)]);
    const keptNames = Object.keys(ids).filter((name) => kept.some((row) => row.id === ids[name])).sort();
    expect(keptNames).toEqual(['foreignLinked', 'foreignNonBridge', 'localOrigin', 'nullOrigin', 'unknownOrigin']);
  });
});
