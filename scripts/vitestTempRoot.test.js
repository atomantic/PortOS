import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVitestTempFixture, runWatchConfigRestart } from './lib/vitestTempRootFixture.js';
import { STALE_ROOT_AGE_MS, killTestBrowsersUnder, sweepStaleRunRoots, writeOwnerFile } from './lib/vitestStaleRunRoots.js';
import { ownTestBodies, recordTempRootOwner } from '../server/lib/mockPathsDataRoot.js';
import { isProcessAlive } from '../server/test/processAlive.js';

// Vitest can cancel a wrapper before its async body reaches finally.
const owned = ownTestBodies(it);
afterAll(() => owned.drain());

describe('real workspace runner temp lifecycle', () => {
  const workspace = 'server';
  describe.each(['vitest.config.js', 'vitest.config.db.js'])('%s', (config) => {
    for (const outcome of ['success', 'failure', 'leak']) {
      it(`${workspace} removes framework scratch on ${outcome}, preserving host artifacts`, () => {
        const host = mkdtempSync(join(tmpdir(), 'vrt-'));
        recordTempRootOwner(host);
        try {
          // Even nanoid-looking pre-existing directories belong to the host.
          const untouched = 'A'.repeat(21);
          mkdirSync(join(host, untouched));
          writeFileSync(join(host, untouched, 'keep'), 'host data');
          const body = outcome === 'failure' ? "expect(true).toBe(false);"
            : outcome === 'leak' ? "writeFileSync(join(tmpdir(), 'fixture-leak'), 'unexpected');"
              : 'expect(true).toBe(true);';
          const { args, options } = createVitestTempFixture(host, workspace, body, config);
          const result = spawnSync(process.execPath, args, options);
          expect(result.error).toBeUndefined();
          expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(outcome === 'success' ? 0 : 1);
          if (outcome === 'leak') expect(result.stderr).toContain('test temp leak: fixture-leak');
          expect(readdirSync(host).sort()).toEqual([untouched, 'fixture'].sort());
        } finally {
          rmSync(host, { recursive: true, force: true });
        }
      }, 25000);
    }
  });

  it.each(['source-owned', 'outside-repo'])('retains composition provenance after a passing %s worker ends, without changing the global leak failure', mode => {
    const repo = fileURLToPath(new URL('../', import.meta.url));
    const host = mkdtempSync(mode === 'source-owned' ? join(repo, 'server/test/fixtures/provenance-worker-') : join(tmpdir(), 'vrt-'));
    recordTempRootOwner(host);
    try {
      const { args, options } = createVitestTempFixture(host, 'server', `
        const { channel } = await import('node:diagnostics_channel');
        const { EventEmitter } = await import('node:events');
        const { mkdtempSync } = await import('node:fs');
        const profile = mkdtempSync(join(first, 'portos-composition-browser-'));
        writeFileSync(join(profile, 'fixture'), 'synthetic');
        const observations = channel('portos.composition-browser.lifecycle');
        const child = new EventEmitter();
        observations.publish({ event: 'allocated', profile });
        observations.publish({ event: 'child', profile, child });
        observations.publish({ event: 'remove-start', profile });
        expect(true).toBe(true);
      `);
      const result = spawnSync(process.execPath, args, options);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/1 passed/);
      expect(result.stderr).toContain('test temp leak: portos-composition-browser- ×1');
      const owner = mode === 'source-owned' ? relative(repo, join(host, 'fixture/lifecycle.test.js')).split('\\').join('/') : 'unavailable';
      expect(result.stderr).toContain(`owner=${owner}`);
      expect(result.stderr).toContain('fixture-before-global-backstop');
      expect(result.stderr).toContain('removal=pending');
      expect(result.stderr).toContain('observer=ended');
      expect(result.stderr).not.toContain(host);
      expect(readdirSync(host)).toEqual(['fixture']);
    } finally { rmSync(host, { recursive: true, force: true }); }
  }, 25000);

  it('reuses config ownership on reimport and reclaims it after interruption, preserving a live owner', async () => {
    const host = mkdtempSync(join(tmpdir(), 'vrt-'));
    recordTempRootOwner(host);
    let child;
    try {
      const live = join(host, 'pvt-live');
      mkdirSync(live);
      writeOwnerFile(live);
      const env = { ...process.env, TMPDIR: host, TMP: host, TEMP: host };
      delete env.PORTOS_TEST_TEMP_ROOT;
      // Load the real config in an interrupted process; IPC acknowledges that
      // ownership is stamped before the parent kills it, without sleeps.
      child = spawn(process.execPath, ['--input-type=module', '-e',
        `await import(${JSON.stringify(new URL('../server/vitest.config.js', import.meta.url).href)});
         const root = process.env.PORTOS_TEST_TEMP_ROOT;
         await import(${JSON.stringify(new URL('../server/vitest.config.js?reimport', import.meta.url).href)});
         if (process.env.PORTOS_TEST_TEMP_ROOT !== root) throw Error('reimport created another root');
         // Keep IPC referenced until the parent deliberately interrupts this owner.
         process.on('message', () => {});
         process.send(root);`],
        { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const closed = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      const owned = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('config did not start')), 15000);
        child.once('message', root => { clearTimeout(timer); resolve(root); });
        child.once('error', err => { clearTimeout(timer); reject(err); });
        child.once('exit', () => { clearTimeout(timer); reject(Error('config exited before handshake')); });
      });
      expect(existsSync(owned)).toBe(true);
      sweepStaleRunRoots(host);
      expect(existsSync(owned)).toBe(true);
      child.kill('SIGKILL');
      await closed;
      sweepStaleRunRoots(host);
      expect(existsSync(owned)).toBe(false);
      expect(existsSync(live)).toBe(true);
    } finally {
      child?.kill('SIGKILL');
      rmSync(host, { recursive: true, force: true });
    }
  }, 20000);
  owned.it('server watch-config restart re-stamps the live owner so a later sweep keeps the root', async ({ signal }) => {
    const host = mkdtempSync(join(tmpdir(), 'vrt-'));
    recordTempRootOwner(host);
    let cleanupConfirmed = true;
    try {
      await runWatchConfigRestart(host, 'server', ({ first, restarted, pid }) => {
        // The restart reused the pathname and the main process re-stamped it.
        expect(restarted.root).toBe(first.root);
        expect(restarted.owner.split(' ')[0]).toBe(String(pid));
        expect(existsSync(join(first.root, '.owner.pid'))).toBe(true);
        // Six idle hours later, the next launch's sweep must not reclaim a live watcher.
        const aged = new Date(Date.now() - STALE_ROOT_AGE_MS - 60000);
        utimesSync(first.root, aged, aged);
        sweepStaleRunRoots(host);
        expect(existsSync(first.root)).toBe(true);
        rmSync(mkdtempSync(join(first.root, 'after-sweep-')), { recursive: true });
      }, { signal });
    } catch (error) {
      if (error.code === 'FIXTURE_CLOSE_UNCONFIRMED') cleanupConfirmed = false;
      // Cancellation is expected, but failed process settlement is still fatal.
      if (error.code !== 'FIXTURE_CALLER_CANCELLED') throw error;
    } finally {
      if (cleanupConfirmed) rmSync(host, { recursive: true, force: true });
    }
  }, 150000); // must exceed the fixture's readiness bound (WATCH_READY_MS)
});

// #10840: a capture browser whose test process died without cleanup.
describe.skipIf(process.platform === 'win32')('orphaned test browser sweep', () => {
  // Stand-in for a test Chrome: a detached process carrying a test profile flag,
  // started by a parent that exits without cleanup. Returns both pids.
  const orphanBrowser = profile => {
    const parent = spawnSync(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--headless=new', '--user-data-dir=' + ${JSON.stringify(profile)}], { detached: true, stdio: 'ignore' });
      child.unref();
      process.stdout.write(String(child.pid));`], { encoding: 'utf8' });
    expect(parent.status, parent.stderr).toBe(0);
    return { parentPid: parent.pid, pid: Number(parent.stdout) };
  };
  const gone = async pid => {
    for (let i = 0; i < 100 && isProcessAlive(pid); i++) await new Promise(resolve => setTimeout(resolve, 50));
    return !isProcessAlive(pid);
  };

  it('stops a browser left by a dead run and keeps one a live run still owns', async () => {
    const host = mkdtempSync(join(tmpdir(), 'vrt-'));
    recordTempRootOwner(host);
    const pids = [];
    try {
      const dead = join(host, 'pvt-dead');
      mkdirSync(join(dead, 'profile'), { recursive: true });
      const orphan = orphanBrowser(join(dead, 'profile'));
      pids.push(orphan.pid);
      // The run that owned the root is the parent that already exited.
      writeFileSync(join(dead, '.owner.pid'), `${orphan.parentPid} 0\n`);
      const live = join(host, 'pvt-live');
      mkdirSync(join(live, 'profile'), { recursive: true });
      writeOwnerFile(live);
      const owned = orphanBrowser(join(live, 'profile'));
      pids.push(owned.pid);
      expect(isProcessAlive(orphan.pid)).toBe(true);

      sweepStaleRunRoots(host);
      expect(await gone(orphan.pid)).toBe(true);
      expect(existsSync(dead)).toBe(false);
      expect(isProcessAlive(owned.pid)).toBe(true);

      // The owning run stops its own browsers as it exits.
      expect(killTestBrowsersUnder(live)).toBe(1);
      expect(await gone(owned.pid)).toBe(true);
    } finally {
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(host, { recursive: true, force: true });
    }
  }, 20000);

  it('stops a browser whose run root was already removed', async () => {
    const host = mkdtempSync(join(tmpdir(), 'vrt-'));
    recordTempRootOwner(host);
    let pid;
    try {
      ({ pid } = orphanBrowser(join(host, 'pvt-removed', 'profile')));
      sweepStaleRunRoots(host);
      expect(await gone(pid)).toBe(true);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(host, { recursive: true, force: true });
    }
  }, 20000);
});

describe('npm debug log containment', () => {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  it.each(['server/vitest.config.js', 'server/vitest.config.db.js', 'client/vitest.config.js'])(
    '%s disables npm log files for workers',
    config => {
      const source = readFileSync(join(repo, config), 'utf8');
      expect(source).toMatch(/npm_config_logs_max:\s*'0'/);
    },
  );

  it('bootstrap disables npm log files for the runner process', () => {
    const source = readFileSync(join(repo, 'scripts/lib/vitestTempRoot.js'), 'utf8');
    expect(source).toMatch(/process\.env\.npm_config_logs_max\s*=\s*'0'/);
  });
});
