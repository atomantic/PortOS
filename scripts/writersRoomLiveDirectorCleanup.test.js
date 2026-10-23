import { afterAll, expect, it as vitestIt } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

it('drains Live Director writes before cleaning a cancelled test fixture', async ({ signal }) => {
  const host = mkdtempSync(join(tmpdir(), 'wr-live-cancel-'));
  try {
    const fixture = join(host, 'fixture');
    const ready = join(fixture, 'ready');
    const finished = join(fixture, 'finished');
    const resultsPath = join(host, 'results.json');
    const runDiagnosticsPath = join(host, 'run.json');
    const fixtureRun = createVitestTempFixture(host, 'server', '');
    const { args, options } = fixtureRun;
    const sourcePath = fileURLToPath(new URL('../server/services/writersRoom/liveDirector.test.js', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8')
      .replace(/(['"])(\.\.?\/[^'"]+)\1/g, (_, quote, specifier) => JSON.stringify(resolve(dirname(sourcePath), specifier)))
      .replace("liveDirectorTest('throws LIVE_MODE_OFF when the work has not opted in', async () => {\n    const work = await createWork({ title: 'Off' });", `liveDirectorTest('throws LIVE_MODE_OFF when the work has not opted in', async ({ signal }) => {
    const work = await createWork({ title: 'Off' });
    const { writeFileSync } = await import('node:fs');
    const cancelled = new Promise(resolve => signal.addEventListener('abort', () => setImmediate(resolve), { once: true }));
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    await cancelled;
    await createWork({ title: 'Synthetic interrupted work' });
    writeFileSync(${JSON.stringify(finished)}, 'finished');
    return;`);
    expect(source).toContain('await cancelled;');
    writeFileSync(join(fixture, 'lifecycle.test.js'), source + `
      afterAll(async () => {
        const { existsSync } = await import('node:fs');
        await vi.waitFor(() => expect(existsSync(${JSON.stringify(finished)})).toBe(true), { timeout: 1000 });
      });
    `);
    writeFileSync(join(fixture, 'failure.test.js'), fixtureReadyFailureSource(ready));
    const workerIndex = args.indexOf('--maxWorkers');
    args[workerIndex + 1] = '2';
    args.push('--bail=1', '--reporter=json', `--outputFile.json=${resultsPath}`,
      `--reporter=${fileURLToPath(new URL('./vitestRunDiagnostics.js', import.meta.url))}`);
    fixtureRun.options = { ...options, env: { ...options.env, PORTOS_CI_DIAGNOSTICS_PATH: runDiagnosticsPath } };
    const result = await runFixtureToCompletion(fixtureRun, RUN_CEILING_MS, { signal });
    if (signal.aborted) return;
    const phases = ['ready', 'finished'].map(name => `${name}=${existsSync(join(fixture, name))}`).join(' ');
    const output = `${result.stdout}\n${result.stderr}\nlifecycle phases: ${phases}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(existsSync(finished), output).toBe(true);
    expect(output).not.toMatch(/refused|unhandled|test temp leak: wr-live-test-/i);
    const report = JSON.parse(readFileSync(resultsPath, 'utf8'));
    expect(report).toMatchObject({ numFailedTests: 1, numPassedTests: 0, numPendingTests: 21, numTotalTests: 22 });
    const failures = report.testResults.flatMap(suite => suite.assertionResults)
      .filter(assertion => assertion.status === 'failed');
    expect(failures.map(assertion => assertion.title), output).toEqual(['controlled sibling failure']);
    const runDiagnostics = JSON.parse(readFileSync(runDiagnosticsPath, 'utf8'));
    expect(runDiagnostics.errorCount).toBe(0);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}, RUN_CEILING_MS + 15000);
