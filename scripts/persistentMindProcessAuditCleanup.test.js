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
// process-audit test while its body still owns fixture writes (an archived job
// and a ledger write) into the shared root that the suite's afterAll removes.
it('drains process-audit fixture writes after another worker triggers fail-fast', async ({ signal }) => {
  const host = mkdtempSync(join(tmpdir(), 'pa-cancel-'));
  try {
    const fixture = join(host, 'fixture');
    const ready = join(fixture, 'ready');
    const finished = join(fixture, 'finished');
    const fixtureRun = createVitestTempFixture(host, 'server', '');
    const { args, options } = fixtureRun;
    const sourcePath = fileURLToPath(new URL('../server/services/persistentMindProcessAudit.test.js', import.meta.url));
    const header = "it('holds an ambiguous create durably instead of publishing twice', async () => {";
    const source = readFileSync(sourcePath, 'utf8')
      .replace(/(['"])(\.\.?\/[^'"]+)\1/g, (_, _quote, specifier) => JSON.stringify(resolve(dirname(sourcePath), specifier)))
      .replace(header, `${header.replace('async () =>', 'async ({ signal }) =>')}
        const { writeFileSync } = await import('node:fs');
        const cancelled = new Promise(resolve => signal.addEventListener('abort', () => setImmediate(resolve), { once: true }));
        writeFileSync(${JSON.stringify(ready)}, 'ready');
        await cancelled;
        await addJob('agent-interrupted');
        await next({ turnId: 'interrupted-turn' });
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
    const output = `${result.stdout}\n${result.stderr}`;
    const diagnostics = [
      `Child error: ${result.error?.stack ?? 'none'}; code: ${result.error?.code ?? 'none'}`,
      `Child status: ${result.status}; signal: ${result.signal}`,
      `Fixture ready: ${existsSync(ready)}; finished: ${existsSync(finished)}`,
      `stdout:\n${result.stdout ?? ''}`,
      `stderr:\n${result.stderr ?? ''}`,
    ].join('\n');
    expect(result.error, diagnostics).toBeUndefined();
    expect(result.status, diagnostics).toBe(1);
    expect(output, diagnostics).toContain('controlled sibling failure');
    expect(existsSync(finished), diagnostics).toBe(true);
    expect(output, diagnostics).not.toMatch(/ENOTEMPTY|ENOENT|Unhandled|test temp leak:/);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}, RUN_CEILING_MS + 15000);
