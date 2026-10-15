import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVitestTempFixture, fixtureReadyFailureSource } from './lib/vitestTempRootFixture.js';

it('drains Live Director writes before cleaning a cancelled test fixture', () => {
  const host = mkdtempSync(join(tmpdir(), 'wr-live-cancel-'));
  try {
    const fixture = join(host, 'fixture');
    const ready = join(fixture, 'ready');
    const finished = join(fixture, 'finished');
    const resultsPath = join(host, 'results.json');
    const runDiagnosticsPath = join(host, 'run.json');
    const { args, options } = createVitestTempFixture(host, 'server', '');
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
    const result = spawnSync(process.execPath, args, {
      ...options,
      env: { ...options.env, PORTOS_CI_DIAGNOSTICS_PATH: runDiagnosticsPath },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.error).toBeUndefined();
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
}, 25000);
