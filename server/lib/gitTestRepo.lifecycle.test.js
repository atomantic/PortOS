import { afterEach, describe, expect, it as vitestIt } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createVitestTempFixture, fixtureReadyFailureSource, runFixtureToCompletion, waitForFixtureReady,
} from '../../scripts/lib/vitestTempRootFixture.js';

import { ownTestBodies } from './mockPathsDataRoot.js';
import { SKIP_HEAVY_INTEGRATION } from './gitTestRepo.js';

const owned = ownTestBodies(vitestIt);
const it = owned.it;
afterEach(() => owned.drain());

const suiteUrl = new URL('../services/git.ensureLatest.test.js', import.meta.url);
const fixtureUrl = new URL('../../scripts/lib/vitestTempRootFixture.js', import.meta.url).href;
const gitUrl = new URL('./execGit.js', import.meta.url).href;

// Run the actual ensureLatest cases. The shim observes the body and cleanup
// boundaries without owning cleanup; even the broken baseline settles its late
// work before the nested process exits, so a killed worker cannot hide the race.
function instrumentSuite(root) {
  const shim = join(root, 'observed-vitest.js');
  writeFileSync(shim, `
    import { it as rawIt, afterEach as rawAfterEach, afterAll } from 'vitest';
    import { existsSync, writeFileSync } from 'node:fs';
    export * from 'vitest';
    const pending = new Set();
    const failures = [];
    let earlyCleanup = false;
    export const it = (name, body, ...rest) => rawIt(name, context => {
      const run = body(context);
      pending.add(run);
      run.then(() => pending.delete(run), error => { pending.delete(run); failures.push(error.message); });
      return run;
    }, ...rest);
    export const afterEach = body => rawAfterEach(async context => {
      writeFileSync(process.env.GIT_FIXTURE_CLEANUP, 'started');
      try { await body(context); }
      finally { earlyCleanup ||= pending.size > 0; }
    });
    afterAll(async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      const state = globalThis.__gitFixtureObservation;
      writeFileSync(process.env.GIT_FIXTURE_RESULT, JSON.stringify({
        earlyCleanup, failures, activeGit: state.activeGit,
        scratchExists: existsSync(state.scratch),
      }));
    });
  `);
  return readFileSync(suiteUrl, 'utf8').replace(/from '([^']+)'/g, (statement, specifier) => {
    if (specifier === 'vitest') return `from ${JSON.stringify(shim)}`;
    return specifier.startsWith('.') ? `from ${JSON.stringify(new URL(specifier, suiteUrl).href)}` : statement;
  });
}

function lifecycleSource(root, phase) {
  return `
    import { beforeEach, vi } from 'vitest';
    import { dirname } from 'node:path';
    import { writeFileSync } from 'node:fs';
    import { waitForFixtureReady } from ${JSON.stringify(fixtureUrl)};
    const state = vi.hoisted(() => ({ scratch: '', held: false, activeGit: 0 }));
    globalThis.__gitFixtureObservation = state;
    beforeEach(({ signal }) => {
      signal.addEventListener('abort', () => writeFileSync(process.env.GIT_FIXTURE_CANCELLED, 'cancelled'), { once: true });
    });
    vi.mock('fs/promises', async original => {
      const fs = await original();
      return { ...fs, cp: async (src, dest, options) => {
        if (!state.scratch && String(dest).includes('portos-git-') && String(dest).endsWith('primary')) {
          state.scratch = dirname(dest);
          if (${JSON.stringify(phase)} === 'allocation') {
            writeFileSync(process.env.GIT_FIXTURE_READY, 'allocated');
            await waitForFixtureReady(process.env.GIT_FIXTURE_RELEASE);
          }
          if (${JSON.stringify(phase)} === 'copy-failure') {
            await fs.cp(src, dest, options);
            throw new Error('controlled sandbox copy failure');
          }
        }
        return fs.cp(src, dest, options);
      } };
    });
    vi.mock(${JSON.stringify(gitUrl)}, async original => {
      const git = await original();
      return { ...git, execGit: async (args, cwd, options) => {
        if (${JSON.stringify(phase)} === 'git' && args[0] === 'commit' && state.scratch && !state.held) {
          state.held = true;
          args = ['-c', 'core.hooksPath=' + process.env.GIT_FIXTURE_HOOKS, ...args];
        }
        state.activeGit++;
        try { return await git.execGit(args, cwd, options); }
        finally { state.activeGit--; }
      } };
    });
    ${instrumentSuite(root)}
  `;
}

describe.skipIf(SKIP_HEAVY_INTEGRATION)('ensureLatest Git fixture lifecycle', () => {
  // Unique regressions: fail-fast during unreturned allocation, fail-fast with
  // a live Git/hook child, and rejected allocation before the caller owns it.
  for (const phase of ['allocation', 'git', 'copy-failure']) {
    it(`settles ${phase} before sandbox removal`, async ({ signal }) => {
      const host = mkdtempSync(join(tmpdir(), 'git-lifecycle-'));
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      let running;
      try {
        writeFileSync(join(host, 'keep'), 'unrelated host artifact');
        const fixture = createVitestTempFixture(host, 'server', '');
        const root = fixture.args[fixture.args.indexOf('--root') + 1];
        writeFileSync(join(root, 'vitest.setup.js'), `import ${JSON.stringify(new URL('../vitest.setup.js', import.meta.url).href)};`);
        const ready = join(host, 'ready');
        const release = join(host, 'release');
        const cleanup = join(host, 'cleanup');
        const cancelled = join(host, 'cancelled');
        const resultFile = join(host, 'result.json');
        const hooks = join(root, 'hooks');
        mkdirSync(hooks);
        const hookScript = join(root, 'hold-git.mjs');
        writeFileSync(hookScript, `import { writeFileSync } from 'node:fs';
          import { waitForFixtureReady } from ${JSON.stringify(fixtureUrl)};
          writeFileSync(${JSON.stringify(ready)}, 'Git child running');
          await waitForFixtureReady(${JSON.stringify(release)});`);
        const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
        writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\nexec ${quote(process.execPath.replaceAll('\\', '/'))} ${quote(hookScript.replaceAll('\\', '/'))}\n`, { mode: 0o755 });
        Object.assign(fixture.options.env, {
          GIT_FIXTURE_READY: ready, GIT_FIXTURE_RELEASE: release,
          GIT_FIXTURE_CLEANUP: cleanup, GIT_FIXTURE_CANCELLED: cancelled,
          GIT_FIXTURE_RESULT: resultFile, GIT_FIXTURE_HOOKS: hooks,
        });
        writeFileSync(join(root, 'lifecycle.test.js'), lifecycleSource(root, phase));
        const bailing = phase !== 'copy-failure';
        if (bailing) writeFileSync(join(root, 'neighbor.test.js'), fixtureReadyFailureSource(ready));
        fixture.args[fixture.args.indexOf('--maxWorkers') + 1] = '2';
        fixture.args.push('--bail=1', '--testNamePattern', 'serializes concurrent pulls|controlled sibling failure');
        running = runFixtureToCompletion(fixture, undefined, { signal: controller.signal });
        // End readiness waits if the nested run exits instead of cancelling.
        void running.then(() => controller.abort(new Error('nested fixture ended')));
        if (bailing) {
          await waitForFixtureReady(cancelled, { signal: controller.signal });
          await waitForFixtureReady(cleanup, { signal: controller.signal });
          writeFileSync(release, 'release owned operation after teardown begins');
        }
        const result = await running;
        const output = result.stdout + result.stderr;
        expect(result.error, output).toBeUndefined();
        expect(result.status, output).toBe(1);
        expect(output).toContain(bailing ? 'controlled sibling failure' : 'controlled sandbox copy failure');
        expect(output).not.toMatch(/test temp leak|could not remove run temp root|EPERM/);
        expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toEqual({
          earlyCleanup: false, activeGit: 0, scratchExists: false,
          failures: bailing ? [] : ['controlled sandbox copy failure'],
        });
        expect(readFileSync(join(host, 'keep'), 'utf8')).toBe('unrelated host artifact');
        expect(readdirSync(host).filter(name => name.startsWith('pvt-'))).toEqual([]);
      } finally {
        controller.abort();
        await running;
        signal.removeEventListener('abort', abort);
        rmSync(host, { recursive: true, force: true });
      }
    });
  }
});
