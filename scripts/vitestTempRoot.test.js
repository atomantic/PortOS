import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sweepStaleRunRoots, writeOwnerFile } from './lib/vitestStaleRunRoots.js';

const repo = fileURLToPath(new URL('../', import.meta.url));

function fixture(host, workspace, body) {
  const root = join(host, 'fixture');
  mkdirSync(root);
  symlinkSync(join(repo, workspace, 'node_modules'), join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  mkdirSync(join(root, 'src/test'), { recursive: true });
  writeFileSync(join(root, 'src/test/setup.js'), '');
  writeFileSync(join(root, 'vitest.setup.js'), '');
  const testFile = workspace === 'client' ? 'src/lifecycle.test.js' : 'lifecycle.test.js';
  writeFileSync(join(root, testFile), `
    import { test, expect } from 'vitest';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { writeFileSync } from 'node:fs';
    import { bootstrapVitestTempRoot } from ${JSON.stringify(new URL('./lib/vitestTempRoot.js', import.meta.url).href)};
    test('lifecycle', async () => {
      const first = tmpdir();
      expect(bootstrapVitestTempRoot()).toBe(first);
      expect(process.env.PORTOS_TEST_TEMP_ROOT).toBe(first);
      ${body}
    });
  `);
  const env = { ...process.env, TMPDIR: host, TMP: host, TEMP: host, NODE_DISABLE_COMPILE_CACHE: '1' };
  delete env.PORTOS_TEST_TEMP_ROOT;
  delete env.VITEST_FAST;
  return {
    args: [join(repo, workspace, 'node_modules/vitest/vitest.mjs'), 'run',
      '--config', join(repo, workspace, 'vitest.config.js'), '--root', root, '--maxWorkers', '1'],
    options: { cwd: join(repo, workspace), env, encoding: 'utf8', timeout: 20000 },
  };
}

describe('real workspace runner temp lifecycle', () => {
  for (const workspace of ['server', 'client']) {
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
          const { args, options } = fixture(host, workspace, body);
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
        `await import(${JSON.stringify(new URL('../client/vitest.config.js', import.meta.url).href)});
         const root = process.env.PORTOS_TEST_TEMP_ROOT;
         await import(${JSON.stringify(new URL('../client/vitest.config.js?reimport', import.meta.url).href)});
         if (process.env.PORTOS_TEST_TEMP_ROOT !== root) throw Error('reimport created another root');
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
