import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A restarted server with recovery pending must not reach its application
// graph: start.js resumes recovery first and refuses boot unless it completes.
describe('restart with pending restore recovery', () => {
  const startScript = fileURLToPath(new URL('../start.js', import.meta.url));
  const childEnv = { ...process.env };
  delete childEnv.VITEST;

  const boot = (journalBody) => {
    const root = mkdtempSync(join(tmpdir(), 'portos-restore-boot-'));
    try {
      writeFileSync(join(root, '.portos-disposable-root'), '');
      mkdirSync(join(root, 'data'));
      const journalPath = join(root, 'data', 'database-restore-recovery.json');
      writeFileSync(journalPath, journalBody);
      // No real pg connection is possible: every pool use throws.
      const stub = `export default {Client:class {connectionParameters={ssl:false,sslnegotiation:"postgres"}},types:{setTypeParser(){}},Pool:class {
        on(){} query(){throw Error('POOL_REACHED')} connect(){throw Error('POOL_REACHED')}
      }};`;
      const loader = join(root, 'pg-loader.mjs');
      writeFileSync(loader, `export async function resolve(specifier, context, next) {
        if (specifier === 'pg') return {url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(stub))}, shortCircuit:true};
        return next(specifier, context);
      }`);
      const result = spawnSync(process.execPath, ['--loader', pathToFileURL(loader).href, startScript], {
        encoding: 'utf8',
        env: { ...childEnv, PORTOS_DATA_ROOT: root, PGDATABASE: 'example_test', PGPASSWORD: 'example-only' },
        timeout: 20_000,
      });
      return { ...result, journalAfter: readFileSync(journalPath, 'utf8') };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('refuses boot and keeps the committed operation when repair cannot finish', () => {
    const record = {
      version: 1, id: '00000000-0000-4000-8000-000000000003', stage: 'repairing',
      createdAt: '2026-01-01T00:00:00.000Z', snapshotId: 'snap-1', dumpSha256: 'a'.repeat(64),
      feedPositions: [{ sequencename: 'memories_sync_feed_seq', last_value: '500' }],
    };
    const body = JSON.stringify(record);
    const result = boot(body);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('Database restore recovery is still pending (restore_schema_reconciliation)');
    expect(result.journalAfter).toBe(body);
  });

  it('refuses boot on an unreadable journal without touching it', () => {
    const result = boot('{ damaged');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('Database restore recovery is still pending (DATABASE_RESTORE_RECOVERY)');
    expect(result.journalAfter).toBe('{ damaged');
  });
});
