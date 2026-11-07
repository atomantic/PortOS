import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCRATCH_DB_PATTERN,
  assertScratchDbName,
  createScratchDbSql,
  explainScratchDbError,
  newScratchDbName,
  resolveAdminConnection,
} from './rehearsal-scratch-db.js';

const script = join(dirname(fileURLToPath(import.meta.url)), 'rehearsal-scratch-db.js');

describe('rehearsal scratch database naming', () => {
  it('generates names the test-runner gate (/_test$/) accepts and drop accepts', () => {
    const name = newScratchDbName();
    expect(name).toMatch(/_test$/);
    expect(SCRATCH_DB_PATTERN.test(name)).toBe(true);
    expect(newScratchDbName()).not.toBe(name);
  });

  it.each([
    'portos',
    'portos_test',
    'portos_smoke_test',
    'portos_rehearsal_test',
    'portos_rehearsal_abc_test',
    'portos_rehearsal_0123456789ab',
    'portos_rehearsal_0123456789ab_test; DROP DATABASE portos',
    'portos_rehearsal_0123456789ab_test"',
    '',
    undefined,
  ])('refuses %j', name => {
    expect(() => assertScratchDbName(name)).toThrow(/refusing/);
  });

  it('keeps the admin connection off the install database', () => {
    const connection = resolveAdminConnection({ env: { PGMODE: 'native', PGPORT: '5432' }, root: '/nonexistent' });
    expect(connection.database).toBe('postgres');
    expect(connection.port).toBe(5432);
  });
});

describe('scratch database creation', () => {
  const name = 'portos_rehearsal_0123456789ab_test';
  const pgError = (code, message) => Object.assign(new Error(message), { code });

  it('clones the extension-bearing test database when asked, else builds a bare one', () => {
    expect(createScratchDbSql(name, 'portos_test')).toBe(`CREATE DATABASE "${name}" TEMPLATE "portos_test"`);
    expect(createScratchDbSql(name)).toBe(`CREATE DATABASE "${name}"`);
    expect(() => createScratchDbSql('portos')).toThrow(/refusing/);
  });

  it('turns a missing-extension privilege error into the CONTRIBUTING repair pointer', () => {
    const err = explainScratchDbError(pgError('42501', 'permission denied to create extension "vector"'));
    expect(err.message).toMatch(/cannot create the vector\/pgcrypto extensions/);
    expect(err.message).toMatch(/Repairing a test database whose extensions were dropped/);
    expect(err.message).not.toMatch(/\n/);
  });

  it('names CREATEDB for a role that cannot create the database', () => {
    expect(explainScratchDbError(pgError('42501', 'permission denied to create database')).message).toMatch(/lacks CREATEDB/);
  });

  it('explains a busy template, and notes it when the fallback also failed', () => {
    expect(explainScratchDbError(pgError('55006', 'source database is being accessed by other users')).message)
      .toMatch(/another session is connected/);
    expect(explainScratchDbError(pgError('42501', 'permission denied to create extension "vector"'), { templateBusy: true }).message)
      .toMatch(/was in use by another session/);
  });

  it('passes unrelated errors through untouched', () => {
    const err = pgError('08006', 'connection terminated');
    expect(explainScratchDbError(err)).toBe(err);
  });
});

describe('rehearsal-scratch-db CLI', () => {
  // The name check runs before any connection, so these never reach a database.
  it.each(['portos', 'portos_test', 'portos_rehearsal_nothex_test'])('drop %s exits non-zero with a JSON refusal', name => {
    const result = spawnSync(process.execPath, [script, 'drop', name], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
    expect(JSON.parse(result.stdout).error).toMatch(/refusing/);
  });

  it('rejects an unknown action', () => {
    const result = spawnSync(process.execPath, [script, 'wipe'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).ok).toBe(false);
  });
});
