// Fixture ownership regressions: normal teardown must finish child exit before
// removing its root; a worker abort must not leave an active surrogate behind.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { installDatabaseStubs } from './databaseTransferStubs.js';
import { installCutoverStubs } from './databaseCutoverStubs.js';
import { isProcessAlive } from '../processAlive.js';
import { sweepStaleRunRoots } from '../staleRunRoots.js';

const source = { mode: 'native', host: 'db.example.invalid', port: 5432, database: 'example_test', user: 'example' };
const target = { ...source, mode: 'docker', port: 5561 };
const fixtureUrl = new URL('./databaseCutoverStubs.js', import.meta.url).href;
const transferUrl = new URL('./databaseTransferStubs.js', import.meta.url).href;
const rootsUrl = new URL('../staleRunRoots.js', import.meta.url).href;
let container;
let root;
let cutover;
let owner;
let surrogate;

beforeEach(() => {
  container = mkdtempSync(join(tmpdir(), 'cutover-lifecycle-'));
  root = mkdtempSync(join(container, 'pvt-'));
  writeFileSync(join(root, '.portos-disposable-root'), '');
});
afterEach(async () => {
  await cutover?.stopSurrogates();
  if (owner?.exitCode === null && owner?.signalCode === null) {
    const closed = once(owner, 'close');
    owner.kill('SIGKILL');
    await closed;
  }
  if (surrogate && isProcessAlive(surrogate)) process.kill(surrogate, 'SIGKILL');
  rmSync(container, { recursive: true, force: true });
  cutover = owner = surrogate = undefined;
});
const booted = () => existsSync(join(root, 'stubs', 'events.log'))
  && readFileSync(join(root, 'stubs', 'events.log'), 'utf8').includes('server booted');
const wait = assertion => vi.waitFor(assertion, { timeout: 15_000, interval: 20 });

describe.skipIf(process.platform === 'win32')('cutover fixture ownership', () => {
  it('awaits surrogate exit before the disposable root is removed', async () => {
    const stubs = installDatabaseStubs(root);
    cutover = installCutoverStubs(root, stubs.dir, { source, target });
    surrogate = cutover.launchServer(target);
    await wait(() => expect(booted()).toBe(true));
    expect(isProcessAlive(surrogate)).toBe(true);
    await cutover.stopSurrogates();
    expect(isProcessAlive(surrogate)).toBe(false);
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  });

  it('exits when its worker is aborted, then allows the dead-owner root to be swept', async () => {
    // The real fixture API runs in a separate owner, reproducing a Vitest
    // worker killed before afterEach. No process-liveness mocks or DB calls.
    const code = `import { writeFileSync } from 'node:fs';
import { installDatabaseStubs } from ${JSON.stringify(transferUrl)};
import { installCutoverStubs } from ${JSON.stringify(fixtureUrl)};
import { writeOwnerFile } from ${JSON.stringify(rootsUrl)};
const root = ${JSON.stringify(root)};
writeOwnerFile(root);
const stubs = installDatabaseStubs(root);
const cutover = installCutoverStubs(root, stubs.dir, { source: ${JSON.stringify(source)}, target: ${JSON.stringify(target)} });
writeFileSync(${JSON.stringify(join(root, 'surrogate.pid'))}, String(cutover.launchServer(${JSON.stringify(target)})));
setInterval(() => {}, 1000);`;
    owner = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
    await wait(() => expect(booted()).toBe(true));
    surrogate = Number(readFileSync(join(root, 'surrogate.pid'), 'utf8'));
    expect(isProcessAlive(surrogate)).toBe(true);
    sweepStaleRunRoots(container);
    expect(existsSync(root)).toBe(true);
    const closed = once(owner, 'close');
    owner.kill('SIGKILL');
    await closed;
    await wait(() => expect(isProcessAlive(surrogate)).toBe(false));
    sweepStaleRunRoots(container);
    expect(existsSync(root)).toBe(false);
  });
});
