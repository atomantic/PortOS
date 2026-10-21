/**
 * Migrations 020 + 021 against a real PostgreSQL: state.json's agents map becomes
 * cos_agents rows byte for byte and in order, the runtime reads them back, and
 * the key is retired only afterwards.
 *
 * Runs via `npm run test:db` (→ `portos_test`) ONLY; skips cleanly when no
 * database is reachable.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../../lib/paths.js', async (importOriginal) => {
  const actual = await importOriginal();
  const override = { root: () => paths.root, data: () => `${paths.root}/data`, cos: () => `${paths.root}/data/cos` };
  return { ...actual, PATHS: new Proxy(actual.PATHS, { get: (target, key) => (key in override ? override[key]() : target[key]) }) };
});

const { checkHealth, close, ensureSchema, query, withTransaction } = await import('../../lib/db.js');
const { requireDbOrSkip } = await import('../../lib/dbTestGate.js');
const { up: importUp } = await import('./020-cos-agents-from-state.js');
const { up: retireUp } = await import('./021-retire-state-agents.js');
const { __makePgCosAgentBackend } = await import('../../services/cosAgentRepository.js');

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('db-migrations/020-cos-agents-from-state.db.test', health.connected, 'disposable PostgreSQL unavailable');

const clean = async () => {
  await query('DELETE FROM cos_agents');
  await query('DELETE FROM cos_agent_store');
};

beforeAll(async () => {
  if (!runDb) return;
  paths.root = mkdtempSync(join(tmpdir(), 'cos-agent-migration-db-'));
  await clean();
});
afterAll(async () => {
  if (runDb) await clean();
  if (paths.root) rmSync(paths.root, { recursive: true, force: true });
  if (health.connected) await close();
});

describe.skipIf(!runDb)('migrations 020 + 021 — CoS agent records into PostgreSQL', () => {
  it('imports every record byte for byte, keeps order, then retires the map', async () => {
    const agents = Object.fromEntries(Array.from({ length: 230 }, (_, n) => {
      const id = `agent-example-${String(229 - n).padStart(4, '0')}`;
      return [id, {
        id, taskId: `task-example-${n}`, status: n % 4 === 0 ? 'running' : 'completed',
        startedAt: '2026-10-01T00:00:00.000Z', ...(n % 4 ? { completedAt: '2026-10-01T01:00:00.000Z' } : {}),
        pid: n % 4 === 0 ? 1000 + n : undefined,
        metadata: { note: `quote "x" \\ backslash, tab\t, NUL \u0000, emoji 🚀, }{ #${n}`, zeta: 1, alpha: 2 },
        output: Array.from({ length: n % 7 }, (_, line) => ({ line: `line ${line}` })),
      }];
    }));
    const original = JSON.stringify({ running: false, agents }, null, 2);
    mkdirSync(join(paths.root, 'data/cos'), { recursive: true });
    writeFileSync(join(paths.root, 'data/cos/state.json'), original);

    await withTransaction(importUp);

    const backend = __makePgCosAgentBackend({ query, withTransaction });
    const { version, rows } = await backend.loadAgents();
    expect(version).toBe(1);
    expect(rows.map((row) => row.id)).toEqual(Object.keys(agents));
    expect(rows.map((row) => row.body)).toEqual(Object.values(agents).map((agent) => JSON.stringify(agent)));
    expect((await query(`SELECT count(*)::int AS n FROM cos_agents WHERE status = 'running' AND pid IS NOT NULL`)).rows[0].n).toBe(58);
    expect(JSON.parse(readFileSync(join(paths.root, 'data/cos/state.json'), 'utf8')).agents).toBeDefined();

    await withTransaction(retireUp);
    expect(JSON.parse(readFileSync(join(paths.root, 'data/cos/state.json'), 'utf8'))).toEqual({ running: false });
    expect(readFileSync(join(paths.root, 'data/cos/state.json.imported'), 'utf8')).toBe(original);

    // The runtime's next write is planned against the migrated version.
    await withTransaction(importUp);
    expect((await backend.loadAgents()).version).toBe(1);
  });
});
