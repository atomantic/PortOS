import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it as vitestIt } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { ownTestBodies } from '../server/lib/mockPathsDataRoot.js';

const { it, drain } = ownTestBodies(vitestIt);
afterAll(drain);

const supervisor = new URL('./watch-ci-tests.js', import.meta.url).href;
const reporter = new URL('./vitestRunDiagnostics.js', import.meta.url).href;

describe.skipIf(process.platform === 'win32')('independent browser test watchdog', () => {
  for (const [stalled, status, denied, orphan] of [[false, 0, false, false], [false, 17, false, false], [true, 17, false, false], [true, 17, true, false], [false, 0, false, true]]) {
  it(`preserves status or interrupts a stopped launcher with prior progress (stalled=${stalled}, status=${status}, denied=${denied}, orphan=${orphan})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ci-watchdog-'));
    const reports = join(root, 'reports');
    mkdirSync(reports);
    try {
      const npm = join(root, 'npm.mjs');
      writeFileSync(npm, `
        import reporter from ${JSON.stringify(reporter)};
        import { writeFileSync } from 'node:fs';
        import { spawn } from 'node:child_process';
        const hooks = reporter();
        hooks.onInit({ onClose() {} });
        hooks.onTestModuleQueued({ moduleId: 'server/lib/synthetic.test.js' });
        const orphan = ${orphan} ? spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }) : null;
        writeFileSync(${JSON.stringify(join(root, 'owned.json'))}, JSON.stringify({ worker: process.pid, launcher: process.ppid, orphan: orphan?.pid }));
        if (orphan) { await new Promise(resolve => orphan.once('message', resolve)); orphan.disconnect(); orphan.unref(); }
        if (${stalled}) {
          // Stop the launcher's event loop: its own signal handler cannot help.
          // The independent supervisor must retire the inherited known group.
          process.on('SIGTERM', () => {});
          process.kill(process.ppid, 'SIGSTOP');
          setInterval(() => {}, 1000);
        } else process.exitCode = ${status};
      `);
      writeFileSync(join(root, 'npm'), `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(npm).href)});`, { mode: 0o755 });
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { watchTests } from ${JSON.stringify(supervisor)};
        const kill = process.kill;
        if (${denied}) process.kill = (pid, signal) => {
          if (pid < 0 && signal === 'SIGKILL') throw Object.assign(Error('synthetic denied signal'), { code: 'EPERM' });
          return kill(pid, signal);
        };
        try { process.exitCode = await watchTests('server', { deadlineMs: 1500, progressMs: 300, graceMs: 200 }); }
        catch (error) { console.error('Synthetic supervisor failed closed: ' + error.message); process.exitCode = 1; }
      `], { encoding: 'utf8', timeout: 10_000, env: { ...process.env,
        PATH: `${root}${delimiter}${process.env.PATH}`, PORTOS_CI_DIAGNOSTICS_DIR: reports,
        // The supervised launcher is the real run-ci-tests.js: pin its plan so the
        // job's own CI_TEST_MODE/CI_SHARD/memo settings cannot put planning work
        // in front of the fake npm the deadlines below are sized for.
        CI_TEST_MODE: 'full', CI_TEST_FILES: '[]', CI_TEST_SOURCES: '[]', CI_SHARD: '', PORTOS_TEST_MEMO: 'off',
        GITHUB_STEP_SUMMARY: '', GITHUB_ENV: '', NODE_DISABLE_COMPILE_CACHE: '1' } });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(denied || orphan ? 1 : stalled ? 124 : status);
      const owned = JSON.parse(readFileSync(join(root, 'owned.json'), 'utf8'));
      if (!denied) for (const pid of [owned.worker, owned.launcher, ...(owned.orphan ? [owned.orphan] : [])]) expect(() => process.kill(pid, 0)).toThrow();
      if (stalled) {
        expect(result.stdout).toContain('CI test watchdog: 0s elapsed');
        const progress = result.stderr.indexOf('server/lib/synthetic.test.js');
        expect(progress).toBeGreaterThanOrEqual(0);
        expect(progress).toBeLessThan(result.stderr.indexOf('subordinate deadline exceeded'));
        if (denied) {
          expect(result.stderr).toContain('owned-runner settlement unverified');
          expect(result.stderr).not.toContain('owned launcher group stopped');
        } else {
          expect(result.stderr).toContain('owned launcher group stopped');
          expect(result.stderr).toContain('independently detached browser groups remain unverified');
        }
        expect(result.stderr).not.toContain(root);
      } else {
        expect(result.stderr).not.toContain('subordinate deadline exceeded');
        if (orphan) {
          expect(result.stderr).toContain('launcher closed with inherited group members remaining');
          expect(result.stderr).toContain('owned launcher group stopped');
        }
      }
    } finally {
      // Even an assertion or supervisor regression must retire this fixture's
      // positively recorded group, including a launcher stopped with SIGSTOP.
      const ownedPath = join(root, 'owned.json');
      if (!existsSync(ownedPath)) throw Error('Synthetic watchdog ownership unavailable; scratch retained.');
      {
        const { launcher } = JSON.parse(readFileSync(ownedPath, 'utf8'));
        try { process.kill(-launcher, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        const until = Date.now() + 5000;
        while (true) {
          try { process.kill(-launcher, 0); }
          catch (error) { if (error.code === 'ESRCH') break; throw error; }
          if (Date.now() >= until) throw Error('Synthetic watchdog group settlement unverified; scratch retained.');
          await delay(25);
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
  }
});
