import { afterAll, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownTestBodies } from '../server/lib/mockPathsDataRoot.js';
import { createVitestTempFixture, fixtureReadyFailureSource, runFixtureToCompletion } from './lib/vitestTempRootFixture.js';
import { writeOwnerFile } from './lib/vitestStaleRunRoots.js';

const sourcePath = fileURLToPath(new URL('./vitestTempRoot.test.js', import.meta.url));
const lifecycleSource = readFileSync(sourcePath, 'utf8')
  .replace(/(['"])(\.\.?\/[^'"]+)\1/g, (_, _quote, specifier) => JSON.stringify(resolve(dirname(sourcePath), specifier)));

const owned = ownTestBodies(it);
afterAll(() => owned.drain());

// Exercise the actual watch test's ownership/cleanup with a different worker
// triggering bail while its nested watcher is active. The injected inspection
// gate waits for cancellation, so a fast restart cannot finish the scenario early.
owned.it('drains the active lifecycle watcher after a sibling fails, preserving an external owner', async ({ signal }) => {
  const host = mkdtempSync(join(tmpdir(), 'watch-cancel-'));
  let cleanupConfirmed = true;
  try {
    const run = createVitestTempFixture(host, 'server', '');
    const fixture = join(host, 'fixture');
    const ready = join(fixture, 'ready');
    const finished = join(fixture, 'finished');
    const live = join(host, 'pvt-live');
    mkdirSync(live);
    writeOwnerFile(live);
    writeFileSync(join(live, 'keep'), 'synthetic external owner');
    const source = lifecycleSource
      .replace("runWatchConfigRestart(host, 'server', ({ first, restarted, pid }) => {", `runWatchConfigRestart(host, 'server', async ({ first, restarted, pid }) => {
        const cancelled = new Promise(resolve => signal.addEventListener('abort', () => setImmediate(resolve), { once: true }));
        writeFileSync(${JSON.stringify(ready)}, 'watch-inspection-active');
        await cancelled;`)
      .replace("  }, 150000); // must exceed", `    writeFileSync(${JSON.stringify(finished)}, 'watch-closed-and-host-removed');
  }, 150000); // must exceed`);
    expect(source).toContain('await cancelled;');
    expect(source).toContain('watch-closed-and-host-removed');
    writeFileSync(join(fixture, 'lifecycle.test.js'), source);
    writeFileSync(join(fixture, 'failure.test.js'), fixtureReadyFailureSource(ready));
    run.args[run.args.indexOf('--maxWorkers') + 1] = '2';
    run.args.push('--bail=1', '--testNamePattern', 'server watch-config restart|controlled sibling failure');
    const result = await runFixtureToCompletion(run, 120000, { signal });
    cleanupConfirmed = result.closeConfirmed;
    if (!cleanupConfirmed) throw result.error;
    if (signal.aborted) return;
    // Deliberately bounded diagnostics: no nested output, paths, PIDs or env.
    const state = JSON.stringify({ ready: existsSync(ready), finished: existsSync(finished), status: result.status, error: result.error?.name ?? null });
    expect(Boolean(result.error), state).toBe(false);
    expect(result.status, state).toBe(1);
    expect(result.stderr.includes('controlled sibling failure'), state).toBe(true);
    expect(existsSync(finished), state).toBe(true);
    expect(/test temp leak:|test process leak:|Unhandled|ENOTEMPTY|ENOENT/.test(result.stderr), state).toBe(false);
    expect(readFileSync(join(live, 'keep'), 'utf8')).toBe('synthetic external owner');
  } finally {
    if (cleanupConfirmed) rmSync(host, { recursive: true, force: true });
  }
}, 135000);

owned.it('retains the lifecycle host and fails when watcher settlement is unconfirmed', async ({ signal }) => {
  const host = mkdtempSync(join(tmpdir(), 'watch-unconfirmed-'));
  let cleanupConfirmed = true;
  try {
    const run = createVitestTempFixture(host, 'server', '');
    const fixture = join(host, 'fixture');
    const allocated = join(fixture, 'allocated');
    const retained = join(fixture, 'retained');
    const helperPath = fileURLToPath(new URL('./lib/vitestTempRootFixture.js', import.meta.url));
    writeFileSync(join(fixture, 'lifecycle.test.js'), `
import { vi } from 'vitest';
vi.mock(${JSON.stringify(helperPath)}, async importOriginal => ({
  ...await importOriginal(),
  runWatchConfigRestart: async host => {
    writeFileSync(${JSON.stringify(allocated)}, host);
    writeFileSync(join(host, 'keep'), 'synthetic original bytes');
    throw Object.assign(new Error('synthetic close unconfirmed'), { code: 'FIXTURE_CLOSE_UNCONFIRMED' });
  },
}));
${lifecycleSource}
afterAll(() => {
  const allocatedHost = readFileSync(${JSON.stringify(allocated)}, 'utf8');
  const present = existsSync(join(allocatedHost, 'keep'));
  const original = present && readFileSync(join(allocatedHost, 'keep'), 'utf8') === 'synthetic original bytes';
  writeFileSync(${JSON.stringify(retained)}, JSON.stringify({ present, original }));
});
`);
    run.args.push('--testNamePattern', 'server watch-config restart');
    const result = await runFixtureToCompletion(run, 120000, { signal });
    cleanupConfirmed = result.closeConfirmed;
    if (!cleanupConfirmed) throw result.error;
    if (signal.aborted) return;
    const state = JSON.stringify({ status: result.status, retained: existsSync(retained), error: result.error?.name ?? null });
    expect(Boolean(result.error), state).toBe(false);
    expect(result.status, state).toBe(1);
    expect(result.stderr.includes('synthetic close unconfirmed'), state).toBe(true);
    expect(existsSync(retained), state).toBe(true);
    expect(JSON.parse(readFileSync(retained, 'utf8'))).toEqual({ present: true, original: true });
    expect(result.stderr.includes('test temp leak: vrt-'), state).toBe(true);
  } finally {
    if (cleanupConfirmed) rmSync(host, { recursive: true, force: true });
  }
}, 135000);
