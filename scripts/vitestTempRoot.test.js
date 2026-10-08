import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVitestTempFixture } from './lib/vitestTempRootFixture.js';
import { sweepStaleRunRoots, writeOwnerFile } from './lib/vitestStaleRunRoots.js';

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
});
