import { afterEach, describe, expect, it as vitestIt } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createVitestTempFixture, runFixtureToCompletion, waitForFixtureReady,
} from '../../scripts/lib/vitestTempRootFixture.js';
import { ownTestBodies } from '../lib/mockPathsDataRoot.js';

const owned = ownTestBodies(vitestIt);
const it = owned.it;
afterEach(() => owned.drain());

const suiteUrl = new URL('./backup.test.js', import.meta.url);
const fixtureUrl = new URL('../../scripts/lib/vitestTempRootFixture.js', import.meta.url).href;
const selectedCase = 'preserves non-rewound execution authority and ownership at Backup-Admission/publications/owner.json';

// Execute the real authority case and its hooks. Observe teardown without
// owning it: the final observer drains only AFTER the suite's removals, so an
// unowned body cannot disappear when Vitest closes its worker.
function instrumentSuite(root, tracked, phase) {
  const shim = join(root, 'observed-vitest.js');
  writeFileSync(shim, `
    import { it as rawIt, afterEach as rawAfterEach, afterAll as rawAfterAll } from 'vitest';
    import { existsSync, writeFileSync } from 'node:fs';
    export * from 'vitest';
    export const pending = new Set();
    export const failures = [];
    export let earlyCleanup = false;
    rawAfterAll(async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      writeFileSync(process.env.BACKUP_FIXTURE_RESULT, JSON.stringify({
        earlyCleanup, failures, snapshotExists: existsSync(globalThis.__backupSnapshotRoot),
        installExists: existsSync(globalThis.__backupInstallRoot),
      }));
    });
    const wrap = register => (name, body, ...rest) => register(name, (...args) => {
      const run = Promise.resolve().then(() => body(...args));
      pending.add(run);
      run.then(() => pending.delete(run), error => { pending.delete(run); failures.push(error.message); });
      return run;
    }, ...rest);
    export const it = Object.assign(wrap(rawIt), {
      each: rows => wrap(rawIt.each(rows)), for: rows => wrap(rawIt.for(rows)),
    });
    export const afterEach = body => rawAfterEach(async () => {
      writeFileSync(process.env.BACKUP_FIXTURE_CLEANUP, 'started');
      try { await body(); }
      finally { earlyCleanup ||= pending.size > 0; }
    });
    export const afterAll = body => rawAfterAll(async () => {
      try { await body(); }
      finally {
        earlyCleanup ||= pending.size > 0;
        writeFileSync(process.env.BACKUP_FIXTURE_REMOVED, 'install cleanup finished');
      }
    });
  `);
  let source = readFileSync(suiteUrl, 'utf8').replace('expect, vi, beforeEach', 'expect, beforeEach');
  if (!tracked) source = source.replaceAll('await authorityBodies.drain();', '');
  source = source.replace(/(from\s+|import\(|vi\.mock\(|vi\.importActual\()(['"])([^'"]+)\2/g, (statement, prefix, _quote, specifier) => {
    if (specifier === 'vitest') return `${prefix}${JSON.stringify(shim)}`;
    return specifier.startsWith('.') ? `${prefix}${JSON.stringify(new URL(specifier, suiteUrl).href)}` : statement;
  });
  // The case writes this authority source itself, then previews and restores
  // it twice. Hold the first source write OR the first real rsync child.
  if (phase.startsWith('source')) {
    source = source.replace('async function writeSnapshotFile(relativePath, content) {', `async function writeSnapshotFile(relativePath, content) {
      if (relativePath === 'Backup-Admission/publications/owner.json' && !globalThis.__backupHeld) {
        globalThis.__backupHeld = true;
        writeFileSync(process.env.BACKUP_FIXTURE_READY, 'source write admitted');
        await waitForFixtureReady(process.env.BACKUP_FIXTURE_RELEASE);
        ${phase === 'source-failure' ? "throw new Error('controlled late source failure');" : ''}
      }`);
  } else {
    source = source.replaceAll('spawnChild(...args)', 'spawnChild(process.execPath, [process.env.BACKUP_FIXTURE_CHILD, ...args[1]], args[2])');
  }
  return `
    import { vi, beforeEach as observeBeforeEach } from 'vitest';
    import { waitForFixtureReady } from ${JSON.stringify(fixtureUrl)};
    observeBeforeEach(({ signal }) => {
      signal.addEventListener('abort', () => writeFileSync(process.env.BACKUP_FIXTURE_CANCELLED, 'cancelled'), { once: true });
    });
    ${source}
  `
    // Capture the suite-local root without exporting or changing its lifetime.
    .replace("tmpRoot = await realFs.mkdtemp(joinPath(tmpdir(), 'portos-restore-integrity-'));", "tmpRoot = await realFs.mkdtemp(joinPath(tmpdir(), 'portos-restore-integrity-')); globalThis.__backupSnapshotRoot = tmpRoot;")
    .replace('return TEST_DATA_ROOT;', 'globalThis.__backupInstallRoot = dirname(TEST_DATA_ROOT); return TEST_DATA_ROOT;');
}

const missingWindowsRsync = process.platform === 'win32' && spawnSync('rsync', ['--version']).error?.code === 'ENOENT';
describe.skipIf(missingWindowsRsync)('backup authority fixture cancellation (#13450)', () => {
  // Unique regression: a cancelled REAL matrix body still owns its next
  // source write and rsync child, not just the current restore promise. The
  // nested 1s timeout is fault injection; production/test budgets stay intact.
  for (const [tracked, phase] of [[false, 'source-write'], [true, 'source-write'], [true, 'rsync'], [true, 'source-failure']]) {
    it(`settles ${phase} before removing fixtures (owned=${tracked})`, async ({ signal }) => {
      const host = mkdtempSync(join(tmpdir(), 'backup-lifecycle-'));
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      let running;
      try {
        const fixture = createVitestTempFixture(host, 'server', '');
        const root = fixture.args[fixture.args.indexOf('--root') + 1];
        writeFileSync(join(root, 'vitest.setup.js'), `import ${JSON.stringify(new URL('../vitest.setup.js', import.meta.url).href)};`);
        const ready = join(host, 'ready'), release = join(host, 'release');
        const cleanup = join(host, 'cleanup'), cancelled = join(host, 'cancelled'), removed = join(host, 'removed');
        const resultFile = join(host, 'result.json'), child = join(host, 'rsync.mjs');
        writeFileSync(child, `
          import { spawnSync } from 'node:child_process';
          import { existsSync, writeFileSync } from 'node:fs';
          import { waitForFixtureReady } from ${JSON.stringify(fixtureUrl)};
          if (!existsSync(process.env.BACKUP_FIXTURE_READY)) {
            writeFileSync(process.env.BACKUP_FIXTURE_READY, 'rsync child admitted');
            await waitForFixtureReady(process.env.BACKUP_FIXTURE_RELEASE);
          }
          const result = spawnSync('rsync', process.argv.slice(2), { stdio: 'inherit' });
          process.exit(result.status ?? 1);
        `);
        Object.assign(fixture.options.env, {
          BACKUP_FIXTURE_READY: ready, BACKUP_FIXTURE_RELEASE: release,
          BACKUP_FIXTURE_CLEANUP: cleanup, BACKUP_FIXTURE_CANCELLED: cancelled,
          BACKUP_FIXTURE_RESULT: resultFile, BACKUP_FIXTURE_CHILD: child, BACKUP_FIXTURE_REMOVED: removed,
        });
        writeFileSync(join(root, 'lifecycle.test.js'), instrumentSuite(root, tracked, phase));
        fixture.args.push('--testTimeout=1000', '--testNamePattern', selectedCase);
        running = runFixtureToCompletion(fixture, undefined, { signal: controller.signal });
        void running.then(() => controller.abort(new Error('nested fixture ended')));
        await waitForFixtureReady(cancelled, { signal: controller.signal });
        await waitForFixtureReady(cleanup, { signal: controller.signal });
        if (!tracked) await waitForFixtureReady(removed, { signal: controller.signal });
        writeFileSync(release, 'release operation after teardown begins');
        const result = await running;
        const output = result.stdout + result.stderr;
        expect(result.error, output).toBeUndefined();
        expect(result.status, output).toBe(1);
        expect(output).toContain('Test timed out in 1000ms');
        const observation = JSON.parse(readFileSync(resultFile, 'utf8'));
        expect(observation.earlyCleanup, output).toBe(!tracked);
        expect(observation.snapshotExists, output).toBe(!tracked);
        expect(observation.installExists, output).toBe(!tracked);
        if (tracked) {
          expect(observation.failures, output).toEqual(phase === 'source-failure' ? ['controlled late source failure'] : []);
          if (phase === 'source-failure') expect(output).toContain('controlled late source failure');
          expect(output).not.toMatch(/test temp leak|could not remove run temp root/);
        } else expect(output).toContain('test temp leak');
      } catch (error) {
        controller.abort();
        const result = await running;
        error.message += `\n${result?.stdout ?? ''}${result?.stderr ?? ''}`;
        throw error;
      } finally {
        controller.abort();
        // A kill watchdog may settle the runner without proving child close.
        // Keep that host for recovery instead of deleting beneath its workers.
        const settled = await running?.catch(() => null);
        signal.removeEventListener('abort', abort);
        if (!running || settled?.closeConfirmed === true) rmSync(host, { recursive: true, force: true });
      }
    });
  }
});
