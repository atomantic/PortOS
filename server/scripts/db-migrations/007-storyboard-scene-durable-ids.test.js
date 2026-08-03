import { describe, it, expect, vi } from 'vitest';
import { up } from './007-storyboard-scene-durable-ids.js';

const makeClient = (rows) => {
  const updates = [];
  const query = vi.fn(async (sql, params) => {
    if (sql.startsWith('SELECT')) return { rows };
    updates.push({ sql, params });
    return { rows: [] };
  });
  return { client: { query }, updates, query };
};

describe('db-migration 007 — storyboard scene durable ids', () => {
  it('stamps scene + shot ids and writes only the scenes path', async () => {
    const { client, updates } = makeClient([
      {
        id: 'iss-a',
        data: { stages: { storyboards: { scenes: [{ description: 'one', shots: [{ description: 'wide' }] }] } } },
      },
    ]);

    await up(client);

    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain("jsonb_set(data, '{stages,storyboards,scenes}'");
    // Never bumps updated_at — a derived normalization must not advance the LWW clock.
    expect(updates[0].sql).not.toContain('updated_at');
    const stamped = JSON.parse(updates[0].params[0]);
    expect(stamped[0].id).toBe('scene-01');
    expect(stamped[0].shots[0].id).toBe('shot-01');
    expect(updates[0].params[1]).toBe('iss-a');
  });

  it('writes nothing for rows whose scenes already carry ids (idempotent re-run)', async () => {
    const { client, updates } = makeClient([
      { id: 'iss-b', data: { stages: { storyboards: { scenes: [{ id: 'scene-01', description: 'one' }] } } } },
    ]);

    await up(client);

    expect(updates).toEqual([]);
  });

  it('skips a row whose scenes are not an array', async () => {
    const { client, updates } = makeClient([
      { id: 'iss-c', data: { stages: { storyboards: { scenes: null } } } },
      { id: 'iss-d', data: {} },
    ]);

    await up(client);

    expect(updates).toEqual([]);
  });
});
