import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { requireDbOrSkip } from '../server/lib/dbTestGate.js';

const { Client } = createRequire(new URL('../server/package.json', import.meta.url))('pg');
const script = fileURLToPath(new URL('./recover-synced-test-fixtures.mjs', import.meta.url));
const connection = {
  database: 'portos_test', host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || 'portos',
  password: process.env.PGPASSWORD || 'portos', options: '', connectionTimeoutMillis: 3000,
};
let client;
let ready = false;
let reason = 'requires PGDATABASE=portos_test';
if (process.env.PGDATABASE === 'portos_test') {
  client = new Client(connection);
  try {
    await client.connect();
    const psql = spawnSync('psql', ['--version'], { encoding: 'utf8', timeout: 5000 });
    ready = psql.status === 0;
    reason = ready ? '' : 'psql executable unavailable';
  } catch {
    reason = 'portos_test is unavailable';
  }
}
const runDb = requireDbOrSkip('fixture recovery CLI', ready, reason);
afterAll(async () => { await client?.end(); });

describe.skipIf(!runDb)('fixture recovery CLI against isolated PostgreSQL tables', () => {
  let schema;
  let root;
  let subsPath;
  let originalBytes;
  const threshold = 1000;
  const tables = ['universes', 'pipeline_series', 'writers_room_works'];

  function run(args = []) {
    return spawnSync(process.execPath, [script, '--data-root=' + root,
      '--uni-threshold=' + threshold, '--ser-threshold=' + threshold, ...args], {
      encoding: 'utf8', timeout: 15000,
      env: {
        ...process.env, PGDATABASE: 'portos_test', PGHOST: connection.host,
        PGPORT: String(connection.port), PGUSER: connection.user, PGPASSWORD: connection.password,
        // No public fallback: every unqualified child query must use only our schema.
        PGOPTIONS: '-c search_path=' + schema + ' -c statement_timeout=5000',
        PGCONNECT_TIMEOUT: '3', PSQLRC: join(root, 'empty-psqlrc'),
      },
    });
  }

  async function snapshot() {
    const result = {};
    for (const table of tables) {
      result[table] = (await client.query('SELECT * FROM ' + schema + '.' + table + ' ORDER BY id')).rows;
    }
    return result;
  }

  beforeEach(async () => {
    schema = 'recovery_test_' + randomUUID().replaceAll('-', '');
    root = mkdtempSync(join(tmpdir(), 'portos-recovery-db-'));
    mkdirSync(join(root, 'sharing'));
    writeFileSync(join(root, 'empty-psqlrc'), '');
    subsPath = join(root, 'sharing', 'peer_subscriptions.json');
    originalBytes = JSON.stringify({ version: 1, subscriptions: [
      { recordKind: 'universe', recordId: 'restore', peerId: 'example-peer' },
      { recordKind: 'universe', recordId: 'fixture' },
      { recordKind: 'universe', recordId: 'missing' },
      { recordKind: 'series', recordId: 'inconsistent' },
      { recordKind: 'series', recordId: 'fixture' },
      { recordKind: 'series', recordId: 'missing' },
      { recordKind: 'mediaCollection', recordId: 'unrelated' },
      { recordKind: 'future-kind', recordId: 'unrelated' },
    ] }) + '\n';
    writeFileSync(subsPath, originalBytes);
    await client.query('CREATE SCHEMA ' + schema);
    for (const table of tables) {
      await client.query('CREATE TABLE ' + schema + '.' + table + ` (
        id text PRIMARY KEY, name text, title text, data jsonb NOT NULL,
        deleted boolean NOT NULL, deleted_at timestamptz, updated_at timestamptz NOT NULL
      )`);
      const records = [
        ['fixture', false, false, threshold - 1],
        ['boundary', false, false, threshold],
        ['above', false, false, threshold + 1],
        ['restore', true, true, threshold + 100],
        ['inconsistent', true, false, threshold + 100],
      ];
      for (const [id, jsonDeleted, columnDeleted, size] of records) {
        const data = { id, deleted: jsonDeleted, updatedAt: '2020-01-01T00:00:00.000Z',
          authored: { text: 'Synthetic authored content', tags: ['retained'] }, padding: '' };
        if (jsonDeleted) data.deletedAt = '2020-01-02T00:00:00.000Z';
        // Measure PostgreSQL's JSONB text representation, which is the CLI's policy.
        const { rows } = await client.query('SELECT length($1::jsonb::text) AS size', [JSON.stringify(data)]);
        data.padding = 'x'.repeat(size - rows[0].size);
        await client.query('INSERT INTO ' + schema + '.' + table +
          ' (id, name, title, data, deleted, deleted_at, updated_at) VALUES ($1,$1,$1,$2,$3,$4,$5)',
        [id, JSON.stringify(data), columnDeleted, jsonDeleted ? '2020-01-02T00:00:00.000Z' : null,
          '2020-01-01T00:00:00.000Z']);
      }
    }
  });

  afterEach(async () => {
    try {
      if (schema) await client.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('default invocation leaves all three tables and subscription bytes unchanged', async () => {
    const before = await snapshot();
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('DRY-RUN');
    expect(await snapshot()).toEqual(before);
    expect(readFileSync(subsPath, 'utf8')).toBe(originalBytes);
    expect(existsSync(subsPath + '.bak')).toBe(false);
  });

  it('restores JSONB and mirrors, respects the size boundary, prunes subscriptions, and is idempotent', async () => {
    const before = await snapshot();
    // Pin the policy boundary independently of the fixture-size construction.
    for (const table of ['universes', 'pipeline_series']) {
      const sizes = (await client.query('SELECT id, length(data::text) AS size FROM ' + schema + '.' + table)).rows;
      expect(sizes.find(r => r.id === 'fixture').size).toBe(threshold - 1);
      expect(sizes.find(r => r.id === 'boundary').size).toBe(threshold);
      expect(sizes.find(r => r.id === 'above').size).toBe(threshold + 1);
    }
    const result = run(['--apply']);
    expect(result.status, result.stderr).toBe(0);
    const after = await snapshot();
    expect(after.writers_room_works).toEqual(before.writers_room_works);
    for (const table of ['universes', 'pipeline_series']) {
      expect(after[table].map(r => r.id)).toEqual(['above', 'boundary', 'inconsistent', 'restore']);
      for (const id of ['above', 'boundary']) {
        expect(after[table].find(r => r.id === id)).toEqual(before[table].find(r => r.id === id));
      }
      for (const id of ['restore', 'inconsistent']) {
        const restored = after[table].find(r => r.id === id);
        const original = before[table].find(r => r.id === id);
        const { deletedAt: _deletedAt, ...originalData } = original.data;
        expect(restored.data).toEqual({ ...originalData, deleted: false, updatedAt: restored.data.updatedAt });
        expect(restored.data).not.toHaveProperty('deletedAt');
        expect(restored.deleted).toBe(false);
        expect(restored.deleted_at).toBeNull();
        expect(restored.updated_at.getTime()).toBeGreaterThan(original.updated_at.getTime());
        expect(restored.data.updatedAt).toBe(restored.updated_at.toISOString());
      }
    }
    const prunedBytes = readFileSync(subsPath, 'utf8');
    const original = JSON.parse(originalBytes);
    expect(JSON.parse(prunedBytes)).toEqual({ ...original,
      subscriptions: original.subscriptions.filter(s => !['fixture', 'missing'].includes(s.recordId)) });
    expect(readFileSync(subsPath + '.bak', 'utf8')).toBe(originalBytes);
    const second = run(['--apply']);
    expect(second.status, second.stderr).toBe(0);
    expect(await snapshot()).toEqual(after);
    expect(readFileSync(subsPath, 'utf8')).toBe(prunedBytes);
    expect(readFileSync(subsPath + '.bak', 'utf8')).toBe(prunedBytes);
  });

  it('rolls back earlier mutations in both tables and leaves subscriptions untouched after a later SQL failure', async () => {
    // The final series purge fails after both restores and the universe purge.
    await client.query('CREATE FUNCTION ' + schema + `.reject_purge() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic purge failure'; END $$`);
    await client.query('CREATE TRIGGER reject_purge BEFORE DELETE ON ' + schema +
      '.pipeline_series FOR EACH ROW EXECUTE FUNCTION ' + schema + '.reject_purge()');
    const before = await snapshot();
    const result = run(['--apply']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('synthetic purge failure');
    expect(await snapshot()).toEqual(before);
    expect(readFileSync(subsPath, 'utf8')).toBe(originalBytes);
    expect(existsSync(subsPath + '.bak')).toBe(false);
  });
});
