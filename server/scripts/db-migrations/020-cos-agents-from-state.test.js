import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../../lib/paths.js', () => ({
  PATHS: { get root() { return paths.root; }, get data() { return `${paths.root}/data`; }, get cos() { return `${paths.root}/data/cos`; } },
}));

const { up: importUp } = await import('./020-cos-agents-from-state.js');
const { up: retireUp } = await import('./021-retire-state-agents.js');

const statePath = () => join(paths.root, 'data/cos/state.json');
const writeState = (value) => { mkdirSync(join(paths.root, 'data/cos'), { recursive: true }); writeFileSync(statePath(), typeof value === 'string' ? value : JSON.stringify(value)); };
const AGENTS = {
  'agent-example-b': { id: 'agent-example-b', taskId: 'task-example-1', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T01:00:00.000Z', pid: 4242, output: [{ line: 'done' }] },
  'agent-example-a': { id: 'agent-example-a', status: 'running', metadata: { note: 'a }{ b' } },
};

// An in-memory stand-in for the two tables, enough to observe what the SQL asks for.
let rows;
let store;
const client = ({ corrupt = null } = {}) => ({
  query: vi.fn(async (sql, params) => {
    if (/INSERT INTO cos_agents/.test(sql)) {
      params[0].forEach((id, i) => rows.set(id, { status: params[2][i], pid: params[5][i], body: corrupt === id ? '{}' : params[6][i] }));
      return { rows: [], rowCount: params[0].length };
    }
    if (/SELECT agent_id, agent::text/.test(sql)) {
      return { rows: params[0].filter((id) => rows.has(id)).map((id) => ({ agent_id: id, body: rows.get(id).body })) };
    }
    if (/INSERT INTO cos_agent_store/.test(sql)) { store += 1; return { rows: [] }; }
    throw new Error(`unexpected query: ${sql}`);
  }),
});

beforeEach(() => {
  rmSync(paths.root, { recursive: true, force: true });
  paths.root = mkdtempSync(join(tmpdir(), 'cos-agent-import-'));
  rows = new Map();
  store = 0;
});
afterAll(() => rmSync(paths.root, { recursive: true, force: true }));

describe('db-migrations 020 + 021 — CoS agent records out of state.json', () => {
  it('imports every agent byte for byte in map order, then retires the key keeping a recovery copy', async () => {
    const original = JSON.stringify({ running: false, stats: { agentsSpawned: 2 }, agents: AGENTS }, null, 2);
    writeState(original);
    const db = client();
    await importUp(db);
    expect([...rows.keys()]).toEqual(['agent-example-b', 'agent-example-a']);
    for (const [id, agent] of Object.entries(AGENTS)) expect(rows.get(id).body).toBe(JSON.stringify(agent));
    expect(rows.get('agent-example-b')).toMatchObject({ status: 'completed', pid: 4242 });
    expect(store).toBe(1);
    // 020 never touches the file; only 021 does, after 020 committed.
    expect(readFileSync(statePath(), 'utf8')).toBe(original);

    await retireUp(db);
    expect(JSON.parse(readFileSync(statePath(), 'utf8'))).toEqual({ running: false, stats: { agentsSpawned: 2 } });
    expect(readFileSync(`${statePath()}.imported`, 'utf8')).toBe(original);

    // Nothing left to move: both are no-ops on a re-run.
    db.query.mockClear();
    await importUp(db);
    await retireUp(db);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('aborts (throws) when a stored record differs from its source, so the boot stops', async () => {
    writeState({ agents: AGENTS });
    await expect(importUp(client({ corrupt: 'agent-example-a' }))).rejects.toThrow('verification failed: 1 of 2');
    expect(store).toBe(0);
  });

  it('refuses to retire the map while any record is missing from cos_agents', async () => {
    writeState({ agents: AGENTS });
    rows.set('agent-example-b', { body: JSON.stringify(AGENTS['agent-example-b']) });
    await expect(retireUp(client())).rejects.toThrow('1 of 2 state.json records are not stored');
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).agents).toEqual(AGENTS);
  });

  it.each([
    ['no state file', null],
    ['unreadable state file', '{broken'],
    ['no agents map', { running: false }],
  ])('does nothing for %s', async (_label, value) => {
    if (value !== null) writeState(value);
    const db = client();
    await importUp(db);
    await retireUp(db);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('retires a non-object agents value without importing it', async () => {
    writeState({ running: true, agents: ['not', 'records'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = client();
      await importUp(db);
      expect(db.query).not.toHaveBeenCalled();
      await retireUp(db);
      expect(JSON.parse(readFileSync(statePath(), 'utf8'))).toEqual({ running: true });
    } finally {
      warn.mockRestore();
    }
  });
});
