import { afterAll, expect, it as vitestIt } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownTestBodies } from '../server/lib/mockPathsDataRoot.js';
import { createVitestTempFixture, fixtureReadyFailureSource, runFixtureToCompletion } from './lib/vitestTempRootFixture.js';

// The nested run's own ceiling; the outer budget adds headroom so it is never tighter.
const RUN_CEILING_MS = 120000;

// A fail-fast failure in another file cancels this body while it awaits the nested
// run; own it so teardown waits for its `finally` to remove the host (#12924).
const owned = ownTestBodies(vitestIt);
const it = owned.it;
afterAll(() => owned.drain());

// Hold the real clean route at its first publication write, then let a different
// worker cancel the test. Its body must finish before its gallery is removed.
for (const preAborted of [false, true]) {
  it(`drains the image cleaner request before removing its cancelled fixture (${preAborted ? 'already-aborted' : 'sibling-aborted'})`, async ({ signal }) => {
    const host = mkdtempSync(join(tmpdir(), 'image-clean-cancel-'));
    let closeConfirmed = true;
    try {
      const fixtureRun = createVitestTempFixture(host, 'server', '');
      const { args } = fixtureRun;
      const fixture = join(host, 'fixture');
      const ready = join(fixture, 'ready');
      const traceFile = join(fixture, 'trace.json');
      const resultsFile = join(fixture, 'results.json');
      const junitFile = join(fixture, 'results.xml');
      const sourcePath = fileURLToPath(new URL('../server/routes/imageGen.clean.test.js', import.meta.url));
      const header = "it('cleans an existing PNG and writes _clean-resize-squeeze.png back to the gallery', async () => {";
      const source = readFileSync(sourcePath, 'utf8')
        .replace("  ({ default: imageGenRoutes } = await import('./imageGen.js'));",
          "  probe.phase('route-import-start');\n  ({ default: imageGenRoutes } = await import('./imageGen.js'));\n  probe.phase('route-import-settled');")
        .replace(/(['"])(\.\.?\/[^'"]+)\1/g, (_, _quote, specifier) => JSON.stringify(resolve(dirname(sourcePath), specifier)))
        .replace('let sandbox;', `let sandbox;
          const probe = vi.hoisted(() => {
            let finish;
            const events = [];
            const phase = name => process.stdout.write('Cleaner fixture phase: ' + name + '\\n');
            phase('lifecycle-worker-start');
            return { events, phase, record: name => { events.push(name); phase(name); }, finished: new Promise(resolve => { finish = resolve; }), finish: () => finish() };
          });`)
        .replace('    ...actual,\n    get PATHS()', `    ...actual,
          atomicWrite: async (...args) => {
            if (args[0].endsWith('render-1_clean-resize-squeeze.png')) {
              const { writeFileSync } = await import('node:fs');
              const cancelled = new Promise(resolve => {
                const release = () => { probe.phase('abort-observed'); setImmediate(resolve); };
                if (probe.signal.aborted) release();
                else probe.signal.addEventListener('abort', release, { once: true });
              });
              probe.events.push('publication-held');
              writeFileSync(${JSON.stringify(ready)}, 'ready');
              ${preAborted ? `// Release is queued before this event-turn barrier, without a clock delay.
              await Promise.race([cancelled, new Promise((_, reject) =>
                setImmediate(() => reject(new Error('already-aborted publication did not release'))))]);` : 'await cancelled;'}
              probe.events.push('publication-released');
            }
            return actual.atomicWrite(...args);
          },
          get PATHS()`)
        .replace(header, `${header.replace('async () =>', 'async ({ signal }) =>')}
          probe.phase('test-body-start');
          probe.signal = ${preAborted ? 'AbortSignal.abort()' : 'signal'};
          try {`)
        .replace("  });\n\n  it('idempotent:", `        } finally {
            probe.events.push('body-settled');
            probe.finish();
          }
        });

        it('idempotent:`)
        .replace('  await rm(sandbox, { recursive: true, force: true });', `  probe.events.push('cleanup-start');
          // A removal failure is recorded in the trace, not thrown past it: the outer
          // test asserts on the trace, so it must always be written.
          let removeError = null;
          try {
            await rm(sandbox, { recursive: true, force: true });
            probe.events.push('cleanup-finished');
          } catch (error) {
            removeError = error.code ?? error.message;
          }
          await probe.finished;
          const { writeFileSync, existsSync, readdirSync } = await import('node:fs');
          writeFileSync(${JSON.stringify(traceFile)}, JSON.stringify({
            events: probe.events,
            remaining: existsSync(sandbox) ? readdirSync(sandbox) : null,
            removeError,
          }));`)
        .replaceAll('probe.events.push(', 'probe.record(');
      expect(source).toContain(`probe.signal = ${preAborted ? 'AbortSignal.abort()' : 'signal'};`);
      expect(source).toContain('return actual.atomicWrite(...args);');
      expect(source).toContain("probe.record('body-settled');");
      writeFileSync(join(fixture, 'lifecycle.test.js'), source);
      const failureSource = fixtureReadyFailureSource(ready)
        .replace('  await waitForFixtureReady(', "  process.stdout.write('Cleaner fixture phase: failure-worker-start\\n');\n  await waitForFixtureReady(")
        .replace("  throw new Error('controlled sibling failure');", "  process.stdout.write('Cleaner fixture phase: controlled-sibling-failure\\n');\n  throw new Error('controlled sibling failure');");
      writeFileSync(join(fixture, 'failure.test.js'), failureSource);
      args[args.indexOf('--maxWorkers') + 1] = '2';
      args.push('--bail=1', '-t', 'cleans an existing PNG|controlled sibling failure', '--reporter=default', '--reporter=json', '--outputFile.json', resultsFile,
        '--reporter=junit', '--outputFile.junit', junitFile);
      closeConfirmed = false;
      const result = await runFixtureToCompletion(fixtureRun, RUN_CEILING_MS, { signal });
      closeConfirmed = result.closeConfirmed;
      if (signal.aborted && closeConfirmed) return;
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.closeConfirmed, output).toBe(true);
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(1);
      // Absent only if the nested worker died before its afterAll finished; say so with the run output.
      expect(existsSync(traceFile), `nested afterAll never wrote its trace\n${output}`).toBe(true);
      const trace = JSON.parse(readFileSync(traceFile, 'utf8'));
      expect(trace, output).toEqual({
        events: ['publication-held', 'publication-released', 'body-settled', 'cleanup-start', 'cleanup-finished'],
        remaining: null,
        removeError: null,
      });
      const report = JSON.parse(readFileSync(resultsFile, 'utf8'));
      expect(report.numFailedTests, output).toBe(1);
      expect(report.numFailedTestSuites, output).toBe(1);
      expect(report.testResults.map(file => file.message), output).toEqual(['', '']);
      // Vitest's JSON reporter omits unhandled run errors; JUnit counts them.
      const totals = readFileSync(junitFile, 'utf8').match(/<testsuites\b[^>]*>/)?.[0];
      expect(totals, output).toMatch(/\berrors="0"/);
      expect(totals, output).toMatch(/\bfailures="1"/);
      const failures = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed');
      expect(failures.map(test => test.title), output).toEqual(['controlled sibling failure']);
      for (const phase of ['lifecycle-worker-start', 'failure-worker-start', 'route-import-start', 'route-import-settled',
        'test-body-start', 'publication-held', 'abort-observed', 'controlled-sibling-failure', 'publication-released',
        'body-settled', 'cleanup-start', 'cleanup-finished']) expect(output).toContain(`Cleaner fixture phase: ${phase}`);
      expect(output).not.toMatch(/ENOTEMPTY|ENOENT|Unhandled|test temp leak:/);
    } finally {
      // Unconfirmed process close cannot authorize removing its fixture beneath it.
      if (closeConfirmed) rmSync(host, { recursive: true, force: true });
    }
  }, RUN_CEILING_MS + 15000);
}
