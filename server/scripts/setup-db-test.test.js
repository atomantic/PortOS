// The exit status is pregate's and CI's only provisioning verdict, so a failed
// run must be non-zero with a readable line, not an uncaught pg stack (#12833).
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describeSetupFailure } from './setupDbTestFailure.mjs';

const SCRIPT = fileURLToPath(new URL('./setup-db-test.mjs', import.meta.url));

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
