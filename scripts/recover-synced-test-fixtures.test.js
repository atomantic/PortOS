import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('child_process', () => ({ execFileSync }));

let root;
let subsPath;
let originalBytes;
const originalArgv = process.argv;
const dryRunExit = new Error('dry-run exit');

async function run(args = []) {
  process.argv = ['node', 'recover-synced-test-fixtures.mjs', '--data-root=' + root, ...args];
  await import('./recover-synced-test-fixtures.mjs');
}

beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'portos-recovery-cli-'));
  mkdirSync(join(root, 'sharing'));
  subsPath = join(root, 'sharing', 'peer_subscriptions.json');
  originalBytes = JSON.stringify({
    version: 1,
    subscriptions: [
      { recordKind: 'universe', recordId: 'live-universe', peerId: 'example-peer' },
      { recordKind: 'universe', recordId: 'missing-universe' },
      { recordKind: 'series', recordId: 'live-series' },
      { recordKind: 'series', recordId: 'missing-series' },
      { recordKind: 'mediaCollection', recordId: 'unrelated-media' },
      { recordKind: 'future-kind', recordId: 'unrelated-record' },
    ],
  }) + '\n';
  writeFileSync(subsPath, originalBytes);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(code => {
    expect(code).toBe(0);
    throw dryRunExit;
  });
  execFileSync.mockReset().mockImplementation((_command, args, options) => {
    if (options.input) return 'COMMIT\n';
    const sql = args.at(-1);
    if (sql.startsWith('SELECT id FROM universes')) return 'live-universe\n';
    if (sql.startsWith('SELECT id FROM pipeline_series')) return 'live-series\n';
    return sql.startsWith('SELECT count(*)') ? '1\n' : '';
  });
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('fixture recovery CLI process and filesystem boundary', () => {
  it('defaults to inspection without issuing writes or touching subscription bytes', async () => {
    await expect(run()).rejects.toBe(dryRunExit);
    expect(execFileSync).toHaveBeenCalledTimes(7);
    for (const [command, args, options] of execFileSync.mock.calls) {
      expect(command).toBe('psql');
      expect(args.at(-1)).toMatch(/^SELECT /);
      expect(options.input).toBeUndefined();
    }
    expect(readFileSync(subsPath, 'utf8')).toBe(originalBytes);
    expect(existsSync(subsPath + '.bak')).toBe(false);
  });

  it('requires explicit apply, forwards thresholds/connection, and prunes only missing universes and series', async () => {
    vi.stubEnv('PGDATABASE', 'portos_test');
    vi.stubEnv('PGHOST', 'db.example.invalid');
    try {
      await run(['--apply', '--uni-threshold=1500', '--ser-threshold=900', '--port=6543']);
    } finally {
      vi.unstubAllEnvs();
    }
    const batches = execFileSync.mock.calls.filter(([, , options]) => options.input);
    expect(batches).toHaveLength(1);
    expect(batches[0][1]).toEqual([
      '-h', 'db.example.invalid', '-p', '6543', '-d', 'portos_test', '-v', 'ON_ERROR_STOP=1',
    ]);
    expect(batches[0][2].input).toMatch(/^\s*BEGIN;/);
    expect(batches[0][2].input).toMatch(/COMMIT;\s*$/);
    expect(batches[0][2].input).toContain('length(data::text) < 1500');
    expect(batches[0][2].input).toContain('length(data::text) < 900');
    const original = JSON.parse(originalBytes);
    expect(JSON.parse(readFileSync(subsPath, 'utf8'))).toEqual({
      ...original, subscriptions: original.subscriptions.filter(s => !s.recordId.startsWith('missing-')),
    });
    expect(readFileSync(subsPath + '.bak', 'utf8')).toBe(originalBytes);
  });

  it('propagates mutation-command failure before rewriting or backing up subscriptions', async () => {
    const failure = new Error('synthetic psql failure');
    const reads = execFileSync.getMockImplementation();
    execFileSync.mockImplementation((command, args, options) => {
      if (options.input) throw failure;
      return reads(command, args, options);
    });
    await expect(run(['--apply'])).rejects.toBe(failure);
    expect(execFileSync).toHaveBeenCalledTimes(8);
    expect(readFileSync(subsPath, 'utf8')).toBe(originalBytes);
    expect(existsSync(subsPath + '.bak')).toBe(false);
  });
});
