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

// Pins the regression uniquely: a different worker's --bail=1 failure cancels
// the promotion test while its body still owns an asynchronous persistence call.
it('drains promotion fixture writes after another worker triggers fail-fast', async ({ signal }) => {
  const host = mkdtempSync(join(tmpdir(), 'wr-cancel-'));
  try {
    const fixture = join(host, 'fixture');
    const ready = join(fixture, 'ready');
    const finished = join(fixture, 'finished');
    const fixtureRun = createVitestTempFixture(host, 'server', '');
    const { args, options } = fixtureRun;
    const sourcePath = fileURLToPath(new URL('../server/services/writersRoom/promoteToPipeline.test.js', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8')
      .replace(/(['"])(\.\.?\/[^'"]+)\1/g, (_, quote, specifier) => JSON.stringify(resolve(dirname(sourcePath), specifier)))
      .replace("async () => {\n    const work = await wrLocal.createWork({ title: 'Blank', kind: 'short-story' });", `async ({ signal }) => {
        const work = await wrLocal.createWork({ title: 'Blank', kind: 'short-story' });
        const { writeFileSync } = await import('node:fs');
        const cancelled = new Promise(resolve => signal.addEventListener('abort', () => setImmediate(resolve), { once: true }));
        writeFileSync(${JSON.stringify(ready)}, 'ready');
        await cancelled;
        await wrLocal.createWork({ title: 'Synthetic interrupted work', kind: 'short-story' });
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
    args.push('--bail=1');
    const result = await runFixtureToCompletion(fixtureRun, RUN_CEILING_MS, { signal });
    if (signal.aborted) return;
    const phases = ['ready', 'finished'].map(name => `${name}=${existsSync(join(fixture, name))}`).join(' ');
    const output = `${result.stdout}\n${result.stderr}\nlifecycle phases: ${phases}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(output).toContain('controlled sibling failure');
    expect(existsSync(finished), output).toBe(true);
    expect(output).not.toMatch(/refused|unhandled|test temp leak:/i);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}, RUN_CEILING_MS + 15000);
