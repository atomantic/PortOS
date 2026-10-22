import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCRATCH_DB_PATTERN,
  assertScratchDbName,
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
