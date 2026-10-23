import { afterAll, expect, it as vitestIt } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownTestBodies } from '../server/lib/mockPathsDataRoot.js';
import { createVitestTempFixture, fixtureReadyFailureSource, runFixtureToCompletion } from './lib/vitestTempRootFixture.js';

// Async nested run: a synchronous spawn clock fails with ETIMEDOUT under
// full-suite load (#13149). The outer budget adds headroom so it is never tighter.
const RUN_CEILING_MS = 120000;

// A fail-fast failure in another file cancels this body while it awaits the nested
// run; own it so teardown waits for its `finally` to remove the host (#12924).
const owned = ownTestBodies(vitestIt);
const it = owned.it;
afterAll(() => owned.drain());

// Pins the regression uniquely: a different worker's --bail=1 failure cancels a
// duplicate-detection test while its body still owns store writes into the
// fixture root, which the suite's teardown must not remove underneath it.
it('drains duplicate-detection fixture writes after another worker triggers fail-fast', async ({ signal }) => {
  const host = mkdtempSync(join(tmpdir(), 'dd-cancel-'));
  try {
    const fixture = join(host, 'fixture');
    const ready = join(fixture, 'ready');
    const finished = join(fixture, 'finished');
    const fixtureRun = createVitestTempFixture(host, 'server', '');
    const { args, options } = fixtureRun;
    const sourcePath = fileURLToPath(new URL('../server/services/duplicateDetection.test.js', import.meta.url));
    const header = "it('reports linkedSeriesCount per universe', async () => {";
    const source = readFileSync(sourcePath, 'utf8')
      .replace(/(['"])(\.\.?\/[^'"]+)\1/g, (_, quote, specifier) => JSON.stringify(resolve(dirname(sourcePath), specifier)))
      .replace(header, `${header.replace('async () =>', 'async ({ signal }) =>')}
        const { writeFileSync } = await import('node:fs');
        const cancelled = new Promise(resolve => signal.addEventListener('abort', () => setImmediate(resolve), { once: true }));
        writeFileSync(${JSON.stringify(ready)}, 'ready');
        await cancelled;
        const interrupted = await universeSvc.createUniverse({ name: 'Interrupted' });
        await seriesSvc.createSeries({ name: 'Interrupted series', universeId: interrupted.id });
        writeFileSync(${JSON.stringify(finished)}, 'finished');
        return;`);
    expect(source).toContain('await cancelled;');
    writeFileSync(join(fixture, 'lifecycle.test.js'), source);
    writeFileSync(join(fixture, 'failure.test.js'), fixtureReadyFailureSource(ready));
    const workerIndex = args.indexOf('--maxWorkers');
    args[workerIndex + 1] = '2';
    args.push('--bail=1');
    const result = await runFixtureToCompletion(fixtureRun, RUN_CEILING_MS, { signal });
    if (signal.aborted) return;
    const phases = ['ready', 'finished'].map(name => `${name}=${existsSync(join(fixture, name))}`).join(' ');
    const output = `${result.stdout}\n${result.stderr}\nlifecycle phases: ${phases}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(output).toContain('controlled sibling failure');
    expect(existsSync(finished), output).toBe(true);
    expect(output).not.toMatch(/ENOTEMPTY|ENOENT|Unhandled|test temp leak:/);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}, RUN_CEILING_MS + 15000);
