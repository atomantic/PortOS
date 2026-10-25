import { afterEach, describe, expect, it as vitestIt } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVitestTempFixture, fixtureReadyFailureSource, runFixtureToCompletion, waitForFixtureReady } from '../../scripts/lib/vitestTempRootFixture.js';
import { ownTestBodies } from '../lib/mockPathsDataRoot.js';
import { SKIP_HEAVY_INTEGRATION } from '../lib/gitTestRepo.js';

const owned = ownTestBodies(vitestIt);
afterEach(() => owned.drain());
const fixtureUrl = new URL('../../scripts/lib/vitestTempRootFixture.js', import.meta.url).href;
const processUrl = new URL('../lib/childProcess.js', import.meta.url).href;

function observedSuite(root, mode, tracked) {
  const name = mode === 'git' ? 'heldCheckoutExactDelivery.integration.test.js' : 'heldCheckoutRecovery.test.js';
  const url = new URL(name, import.meta.url);
  const shim = join(root, 'observed-vitest.js');
  writeFileSync(shim, `
    import { afterEach as rawAfterEach, beforeEach as rawBeforeEach, afterAll } from 'vitest';
    import { waitForFixtureReady } from ${JSON.stringify(fixtureUrl)};
    import { writeFileSync, existsSync } from 'node:fs';
    export * from 'vitest';
    rawBeforeEach(({ signal }) => signal.addEventListener('abort', () =>
      writeFileSync(process.env.RETIRE_CANCELLED, 'cancelled'), { once: true }));
    export const beforeEach = (body, ...options) => rawBeforeEach(async context => {
      if (${JSON.stringify(mode)} !== 'writes') return body(context);
      const controller = new AbortController();
      const deadline = waitForFixtureReady(process.env.RETIRE_CANCELLED, { signal: controller.signal })
        .then(() => { throw new Error('controlled hook deadline'); });
      try { return await Promise.race([body(context), deadline]); }
      finally { controller.abort(); }
    }, ...options);
    export const afterEach = body => rawAfterEach(context => {
      const work = body(context);
      writeFileSync(process.env.RETIRE_CLEANUP, 'cleanup entered');
      return work;
    });
    afterAll(async () => {
      const state = globalThis.__retirementFixture;
      await Promise.allSettled([...state.work]);
      writeFileSync(process.env.RETIRE_RESULT, JSON.stringify({
        earlyRemoval: state.earlyRemoval, active: state.active,
        scratchExists: existsSync(state.scratch),
      }));
    });
  `);
  let source = readFileSync(url, 'utf8').replace(', vi } from', ' } from');
  if (!tracked) {
    source = source.replace('await owned.drain();', '');
    // The negative control observes early teardown, then settles its remaining
    // callback and removes any recreated scratch before the nested run exits.
    const settle = 'afterAll(async () => { try { await owned.drain(); } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); } });';
    if (mode === 'git') source += '\n' + settle;
    else source = source.replace('  let receiptWork;', '  let receiptWork;\n' + settle);
  }
  return source.replace(/(from\s+|import\(|vi\.mock\()(['"])([^'"]+)\2/g, (statement, prefix, quote, specifier) => {
    if (specifier === 'vitest') return `${prefix}${JSON.stringify(shim)}`;
    if (specifier === 'fs/promises') return `${prefix}'node:fs/promises'`;
    return specifier.startsWith('.') ? `${prefix}${JSON.stringify(new URL(specifier, url).href)}` : statement;
  });
}

function lifecycleSource(root, mode, tracked) {
  // Instrument the real fixture boundaries, leaving its retirement assertions
  // and 30-second budgets intact. The injected Git hook is a real child process.
  return `
    import { vi } from 'vitest';
    import { waitForFixtureReady } from ${JSON.stringify(fixtureUrl)};
    const state = vi.hoisted(() => ({ scratch: '', active: 0, held: false, earlyRemoval: false, rootIdentity: null, work: new Set() }));
    globalThis.__retirementFixture = state;
    vi.mock('node:fs/promises', async original => {
      const fs = await original();
      const { statSync, writeFileSync } = await import('node:fs');
      return { ...fs,
        mkdtemp: async (...args) => {
          const path = await fs.mkdtemp(...args);
          if (/detached-delivery-|portos-held-checkout-/.test(String(args[0]))) {
            state.scratch = await fs.realpath(path);
            state.rootIdentity = statSync(path, { bigint: true });
          }
          return path;
        },
        rm: async (path, options) => {
          // Windows Git/Node can spell the same root with long/8.3 paths.
          // Observe the physical root before awaiting anything or releasing I/O.
          let identity;
          try { identity = statSync(path, { bigint: true }); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (identity && state.rootIdentity && identity.dev === state.rootIdentity.dev && identity.ino === state.rootIdentity.ino) {
            state.earlyRemoval ||= state.active > 0;
            writeFileSync(process.env.RETIRE_REMOVAL, 'scratch removal attempted');
          }
          return fs.rm(path, options);
        },
        writeFile: async (path, ...args) => {
          if (${JSON.stringify(mode)} !== 'writes' || !String(path).replaceAll('\\\\', '/').endsWith('/private-files/item-0')) return fs.writeFile(path, ...args);
          state.active++;
          const work = (async () => {
            await fs.writeFile(path, ...args);
            const { writeFileSync } = await import('node:fs');
            writeFileSync(process.env.RETIRE_READY, 'payload write held');
            await waitForFixtureReady(process.env.RETIRE_RELEASE);
          })();
          state.work.add(work);
          try { return await work; }
          finally { state.active--; state.work.delete(work); }
        },
      };
    });
    vi.mock(${JSON.stringify(processUrl)}, async original => {
      const actual = await original();
      return { ...actual, spawn: (command, args, options) => {
        const hold = ${JSON.stringify(mode)} === 'git' && command === 'git' && args[0] === 'commit' && !state.held && String(options?.cwd).startsWith(state.scratch);
        if (!hold) return actual.spawn(command, args, options);
        state.held = true;
        state.active++;
        const child = actual.spawn(command, ['-c', 'core.hooksPath=' + process.env.RETIRE_HOOKS, ...args], options);
        const work = new Promise(resolve => child.once('close', () => { state.active--; state.work.delete(work); resolve(); }));
        state.work.add(work);
        return child;
      } };
    });
    ${observedSuite(root, mode, tracked)}
  `;
}

describe.skipIf(SKIP_HEAVY_INTEGRATION)('retirement fixture cancellation boundary', () => {
  // Each negative control proves the actual suite removes scratch too early
  // without settlement; the matching repair waits for that same owned work.
  for (const mode of ['git', 'writes']) for (const tracked of [false, true]) {
    owned.it(`settles ${mode} before removal with ownership=${tracked}`, async ({ signal }) => {
      const host = mkdtempSync(join(tmpdir(), 'retirement-lifecycle-'));
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      let running;
      let closed = true;
      try {
        const fixture = createVitestTempFixture(host, 'server', '');
        const root = fixture.args[fixture.args.indexOf('--root') + 1];
        writeFileSync(join(root, 'vitest.setup.js'), `import ${JSON.stringify(new URL('../vitest.setup.js', import.meta.url).href)};`);
        const ready = join(host, 'ready'), release = join(host, 'release');
        const cleanup = join(host, 'cleanup'), cancelled = join(host, 'cancelled');
        const removal = join(host, 'removal');
        const resultFile = join(host, 'result.json'), hooks = join(root, 'hooks');
        mkdirSync(hooks);
        const hookScript = join(root, 'hold-git.mjs');
        writeFileSync(hookScript, `import { writeFileSync } from 'node:fs';
          import { waitForFixtureReady } from ${JSON.stringify(fixtureUrl)};
          writeFileSync(${JSON.stringify(ready)}, 'Git child running');
          await waitForFixtureReady(${JSON.stringify(release)});`);
        const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
        writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\nexec ${quote(process.execPath.replaceAll('\\', '/'))} ${quote(hookScript.replaceAll('\\', '/'))}\n`, { mode: 0o755 });
        Object.assign(fixture.options.env, {
          RETIRE_READY: ready, RETIRE_RELEASE: release, RETIRE_CLEANUP: cleanup,
          RETIRE_CANCELLED: cancelled, RETIRE_RESULT: resultFile, RETIRE_HOOKS: hooks, RETIRE_REMOVAL: removal,
        });
        writeFileSync(join(root, 'lifecycle.test.js'), lifecycleSource(root, mode, tracked));
        if (mode === 'git') writeFileSync(join(root, 'neighbor.test.js'), fixtureReadyFailureSource(ready));
        writeFileSync(join(host, 'keep'), 'neighboring artifact');
        fixture.args[fixture.args.indexOf('--maxWorkers') + 1] = '2';
        fixture.args.push('--bail=1', '--testNamePattern', mode === 'git'
          ? 'custom-driver|controlled sibling failure' : 'retains more than 1000|controlled sibling failure');
        closed = false;
        running = runFixtureToCompletion(fixture, undefined, { signal: controller.signal });
        void running.then(() => controller.abort(new Error('nested run ended')));
        if (mode === 'writes') {
          await waitForFixtureReady(ready, { signal: controller.signal });
          writeFileSync(cancelled, 'expire the setup wrapper with owned I/O pending');
        } else await waitForFixtureReady(cancelled, { signal: controller.signal });
        await waitForFixtureReady(cleanup, { signal: controller.signal });
        if (!tracked) await waitForFixtureReady(removal, { signal: controller.signal });
        writeFileSync(release, 'release after teardown starts');
        const result = await running;
        closed = result.closeConfirmed;
        const output = result.stdout + result.stderr;
        expect(result.error, output).toBeUndefined();
        expect(result.status, output).toBe(1);
        expect(output).toContain(mode === 'git' ? 'controlled sibling failure' : 'controlled hook deadline');
        expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toEqual({ earlyRemoval: !tracked, active: 0, scratchExists: false });
        expect(readFileSync(join(host, 'keep'), 'utf8')).toBe('neighboring artifact');
        if (tracked) expect(output).not.toMatch(/test temp leak|could not remove run temp root|EBUSY|ENOENT/);
      } finally {
        controller.abort();
        if (running) closed = (await running).closeConfirmed;
        signal.removeEventListener('abort', abort);
        if (closed) rmSync(host, { recursive: true, force: true });
      }
    });
  }
});
