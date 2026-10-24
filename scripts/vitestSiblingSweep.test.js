import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVitestTempFixture, runFixtureToCompletion, waitForFixtureReady } from './lib/vitestTempRootFixture.js';
import { ownTestBodies, recordTempRootOwner } from '../server/lib/mockPathsDataRoot.js';

const owned = ownTestBodies(it);
afterAll(() => owned.drain());
const rootsModule = new URL('./lib/vitestStaleRunRoots.js', import.meta.url).href;
const processesModule = new URL('./lib/testOwnedProcesses.js', import.meta.url).href;
const fixtureModule = new URL('./lib/vitestTempRootFixture.js', import.meta.url).href;

function fixture(host, name, body, configSource, loader) {
  const directory = join(host, name);
  mkdirSync(directory);
  const result = createVitestTempFixture(directory, 'server', body);
  Object.assign(result.options.env, { TMPDIR: host, TMP: host, TEMP: host });
  const index = result.args.indexOf('--config') + 1;
  const config = result.args[index];
  const wrapper = join(directory, 'fixture/sibling.config.mjs');
  writeFileSync(wrapper, configSource(config));
  result.args[index] = wrapper;
  if (loader === 'default') result.args.splice(result.args.indexOf('--configLoader'), 2);
  return result;
}

// The negative control reproduces the old writer, rather than falsifying the
// liveness probe. Both cases execute the real workspace config and native sweep.
describe.skipIf(process.platform === 'win32')('sibling configuration sweep', () => {
  for (const loader of ['default', 'runner']) {
    for (const legacyEstimate of [false, true]) {
      owned.it(`${loader} loader ${legacyEstimate ? 'reproduces live-worker rejection with the legacy clock estimate' : 'preserves a live worker across a config-time clock offset'}`, async ({ signal }) => {
        const host = mkdtempSync(join(tmpdir(), 'vss-'));
        recordTempRootOwner(host);
        const ready = join(host, 'ready.json');
        const release = join(host, 'release');
        const observations = join(host, 'sweep.json');
        const first = fixture(host, 'first', `
          writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ root: first, worker: process.pid, runner: process.ppid }));
          await (await import(${JSON.stringify(fixtureModule)})).waitForFixtureReady(${JSON.stringify(release)}, { signal: AbortSignal.timeout(25000) });
        `, config => `
          import { writeFileSync } from 'node:fs';
          import { join } from 'node:path';
          const originalNow = Date.now;
          Date.now = () => originalNow() + 60000;
          let config;
          try {
            config = (await import(${JSON.stringify(config)})).default;
            ${legacyEstimate ? `writeFileSync(join(process.env.PORTOS_TEST_TEMP_ROOT, '.owner.pid'), process.pid + ' ' + Math.round(Date.now() - process.uptime() * 1000) + '\\n');` : ''}
          } finally { Date.now = originalNow; }
          export default config;
        `, loader);
        const controller = new AbortController();
        const cancel = () => controller.abort(signal.reason);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        let closed;
        let secondClosed;
        let firstResult;
        let secondResult;
        const readyTimer = setTimeout(() => controller.abort(Error('sibling readiness ceiling')), 30000);
        try {
          closed = runFixtureToCompletion(first, 30000, { signal: controller.signal });
          // A failed launch must abort readiness, rather than masquerade as a
          // timing-dependent pass or wait for a second production sleep.
          void closed.then(() => { if (!existsSync(ready)) controller.abort(Error('first runner exited before readiness')); });
          await waitForFixtureReady(ready, { signal: controller.signal });
          const mark = JSON.parse(readFileSync(ready, 'utf8'));
          const second = fixture(host, 'second', 'expect(true).toBe(true);', config => `
            import { readFileSync, writeFileSync, existsSync } from 'node:fs';
            import { join } from 'node:path';
            import { isOwnerAlive, sweepStaleRunRoots, terminatePid } from ${JSON.stringify(rootsModule)};
            import { probeTestPid, readTestProcesses } from ${JSON.stringify(processesModule)};
            const mark = JSON.parse(readFileSync(${JSON.stringify(ready)}, 'utf8'));
            const [pid, startMs] = readFileSync(join(mark.root, '.owner.pid'), 'utf8').trim().split(/\\s+/).map(Number);
            const observed = { ownerMatchesRunner: pid === mark.runner, ownerAlive: isOwnerAlive({ pid, startMs }), runnerAlive: probeTestPid(mark.runner), rootBefore: existsSync(mark.root), signals: [] };
            sweepStaleRunRoots(${JSON.stringify(host)}, {
              terminate(record, options) {
                const current = readTestProcesses([record.pid]);
                observed.signals.push({ targetIsWorker: record.pid === mark.worker, identityMatches: current?.some(item => item.pid === record.pid && item.start === record.start), valid: options.valid() });
                return terminatePid(record, options);
              },
            });
            observed.rootAfterSweep = existsSync(mark.root);
            writeFileSync(${JSON.stringify(observations)}, JSON.stringify(observed));
            export default (await import(${JSON.stringify(config)})).default;
          `, 'runner');
          secondClosed = runFixtureToCompletion(second, 30000, { signal: controller.signal });
          secondResult = await secondClosed;
          expect(secondResult.error).toBeUndefined();
          expect(secondResult.status).toBe(0);
          const observed = JSON.parse(readFileSync(observations, 'utf8'));
          expect(observed).toMatchObject({ ownerMatchesRunner: true, ownerAlive: !legacyEstimate, runnerAlive: true, rootBefore: true, rootAfterSweep: true });
          expect(observed.signals).toEqual(legacyEstimate ? [{ targetIsWorker: true, identityMatches: true, valid: true }] : []);
          writeFileSync(release, 'release');
          firstResult = await closed;
          expect(firstResult.error).toBeUndefined();
          expect(firstResult.status).toBe(legacyEstimate ? 1 : 0);
          if (legacyEstimate) expect(firstResult.stderr).toContain('signal SIGTERM');
          expect(existsSync(mark.root)).toBe(false);
        } finally {
          clearTimeout(readyTimer);
          signal.removeEventListener('abort', cancel);
          controller.abort();
          firstResult ??= await closed;
          secondResult ??= await secondClosed;
          // Never erase evidence if the fixture could not confirm settlement.
          if ((!closed || firstResult?.closeConfirmed) && (!secondClosed || secondResult?.closeConfirmed)) {
            rmSync(host, { recursive: true, force: true });
          }
        }
      }, 45000);
    }
  }
});
