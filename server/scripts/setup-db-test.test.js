// The exit status is pregate's and CI's only provisioning verdict, so a failed
// run must be non-zero with a readable line, not an uncaught pg stack (#12833).
import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionTestDatabase } from './setup-db-test.mjs';
import { describeSetupFailure } from './setupDbTestFailure.mjs';

const SCRIPT = fileURLToPath(new URL('./setup-db-test.mjs', import.meta.url));

async function fakeProvisioning(onTestFinished, { unobservable, lowWal } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'db-test-storage-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'postgres-data');
  const wal = join(root, 'separate-wal-volume');
  await Promise.all([mkdir(directory), mkdir(wal)]);
  const pidFile = `123\n${directory}\n1234567890\n5432\n`;
  await Promise.all([
    symlink(wal, join(directory, 'pg_wal'), 'junction'),
    writeFile(join(directory, 'postmaster.pid'), pidFile),
  ]);
  const walPath = await realpath(wal);
  const cluster = { directory, pid_file: unobservable === 'container' ? null : pidFile };
  const admin = {
    connect: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    query: vi.fn(async sql => {
      if (sql.includes('pg_settings')) {
        if (unobservable === 'role') throw Object.assign(new Error('permission denied'), { code: '42501' });
        return { rows: [cluster] };
      }
      return { rowCount: 0 };
    }),
  };
  const testDb = { connect: vi.fn(async () => {}), end: vi.fn(async () => {}), query: vi.fn(async () => {}) };
  const createClient = vi.fn(config => config.database === 'portos_test' ? testDb : admin);
  const statfsImpl = vi.fn(async path => {
    if (unobservable === 'wal' && path === walPath) throw new Error('statfs unavailable');
    return {
      blocks: 1024 * 1024,
      bsize: 4096,
      bavail: lowWal && path === walPath ? 32 * 1024 : 512 * 1024,
    };
  });
  const log = vi.fn();
  const env = { PGADMINDATABASE: 'postgres', PGHOST: unobservable === 'remote' ? 'db.example.invalid' : 'localhost' };
  return { admin, createClient, testDb, log, directory: await realpath(directory), walPath, statfsImpl,
    options: { env, createClient, log, storage: { statfsImpl } } };
}

describe('setup-db-test.mjs failure reporting', () => {
  it('exits non-zero with one line and no stack when Postgres is unreachable', () => {
    // Port 1 refuses immediately; no database is needed to exercise the failure path.
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, PGHOST: '127.0.0.1', PGPORT: '1', PGTESTDATABASE: 'portos_test' },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('Schema applied');
    const lines = result.stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^❌ Failed to provision 'portos_test': /);
  });

  it('names the superuser requirement and remedy for a denied CREATE EXTENSION', () => {
    const error = Object.assign(new Error('permission denied to create extension "vector"'), { code: '42501' });
    const line = describeSetupFailure(error, 'portos_test');
    expect(line).toContain('superuser');
    expect(line).toContain("psql -d portos_test -c 'CREATE EXTENSION IF NOT EXISTS vector");
    expect(line).not.toContain('\n');
  });

  it('does not misattribute an unrelated privilege error to extensions', () => {
    const error = Object.assign(new Error('permission denied for table beeper_accounts'), { code: '42501' });
    expect(describeSetupFailure(error, 'portos_test')).not.toContain('superuser');
  });
});

describe('test database storage preflight', () => {
  it('rejects low space on the resolved WAL volume before creating a test database or applying schema', async ({ onTestFinished }) => {
    const fixture = await fakeProvisioning(onTestFinished, { lowWal: true });
    await expect(provisionTestDatabase(fixture.options)).rejects.toThrow(/PostgreSQL WAL volume has .* free.*at least 2 GiB.*disposable test cluster/);
    expect(fixture.statfsImpl.mock.calls).toEqual([[fixture.directory], [fixture.walPath]]);
    expect(fixture.admin.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('pg_settings'));
    expect(fixture.admin.end).toHaveBeenCalledOnce();
    expect(fixture.createClient).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ database: 'postgres' }));
    expect(fixture.testDb.query).not.toHaveBeenCalled();
  });

  it('provisions normally when both PostgreSQL volumes meet the free-space floor', async ({ onTestFinished }) => {
    const fixture = await fakeProvisioning(onTestFinished);
    await provisionTestDatabase(fixture.options);
    expect(fixture.statfsImpl.mock.calls).toEqual([[fixture.directory], [fixture.walPath]]);
    expect(fixture.admin.query).toHaveBeenLastCalledWith('CREATE DATABASE portos_test');
    expect(fixture.testDb.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('CREATE EXTENSION'));
    expect(fixture.log.mock.calls.flat().join('\n')).not.toContain('unchecked');
  });

  for (const [unobservable, reason, probeCount] of [
    ['container', 'the connected PostgreSQL data directory could not be verified on this host', 0],
    ['role', 'the connected PostgreSQL data directory could not be verified on this host', 0],
    ['remote', 'the PostgreSQL endpoint is remote', 0],
    ['wal', 'free space on the PostgreSQL WAL volume is unavailable', 2],
  ]) {
    it(`continues with an explicit diagnostic for unchecked ${unobservable} storage`, async ({ onTestFinished }) => {
      const fixture = await fakeProvisioning(onTestFinished, { unobservable });
      await provisionTestDatabase(fixture.options);
      expect(fixture.statfsImpl).toHaveBeenCalledTimes(probeCount);
      expect(fixture.log).toHaveBeenCalledWith(expect.stringContaining(`DB test storage unchecked: ${reason}`));
      expect(fixture.testDb.query).toHaveBeenCalledOnce();
    });
  }
});
