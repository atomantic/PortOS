import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVitestTempFixture, runWatchConfigRestart } from './lib/vitestTempRootFixture.js';
import { STALE_ROOT_AGE_MS, killTestBrowsersUnder, sweepStaleRunRoots, writeOwnerFile } from './lib/vitestStaleRunRoots.js';
import { isProcessAlive } from '../server/test/processAlive.js';

describe('real workspace runner temp lifecycle', () => {
  const workspace = 'server';
  for (const outcome of ['success', 'failure', 'leak']) {
    it(`${workspace} removes framework scratch on ${outcome}, preserving host artifacts`, () => {
      const host = mkdtempSync(join(tmpdir(), 'vrt-'));
      try {
        // Even nanoid-looking pre-existing directories belong to the host.
        const untouched = 'A'.repeat(21);
        mkdirSync(join(host, untouched));
        writeFileSync(join(host, untouched, 'keep'), 'host data');
        const body = outcome === 'failure' ? "expect(true).toBe(false);"
          : outcome === 'leak' ? "writeFileSync(join(tmpdir(), 'fixture-leak'), 'unexpected');"
            : 'expect(true).toBe(true);';
        const { args, options } = createVitestTempFixture(host, workspace, body);
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

  it('reuses config ownership on reimport and reclaims it after interruption, preserving a live owner', async () => {
    const host = mkdtempSync(join(tmpdir(), 'vrt-'));
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
  it('server watch-config restart re-stamps the live owner so a later sweep keeps the root', async () => {
    const host = mkdtempSync(join(tmpdir(), 'vrt-'));
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
      });
    } finally {
      rmSync(host, { recursive: true, force: true });
    }
  }, 90000);
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
