import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVitestTempFixture, fixtureReadyFailureSource, runFixtureToCompletion } from './lib/vitestTempRootFixture.js';

// The nested run's own ceiling; the outer budget adds headroom so it is never tighter.
const RUN_CEILING_MS = 120000;

// Pins the regression uniquely (#12660): a different worker's --bail=1 failure
// settles a sprite-walk test's wrapper while its body is still writing into the
// suite's tmpdir root. Teardown must wait for that body, or the body's next
// store write recreates the root after `rmSync` and the run reports
// `test temp leak: sprite-walk-test-`.
it('drains sprite-walk fixture writes after another worker triggers fail-fast', async () => {
  const host = mkdtempSync(join(tmpdir(), 'sprite-walk-cancel-'));
  try {
    const fixtureRun = createVitestTempFixture(host, 'server', '');
    const { args } = fixtureRun;
    const fixture = join(host, 'fixture');
    const ready = join(fixture, 'ready');
    const finished = join(fixture, 'finished');
    const sourcePath = fileURLToPath(new URL('../server/services/sprites/walk.test.js', import.meta.url));
    const targetName = '409s when the direction anchor is not locked';
    const header = `it('${targetName}', async () => {`;
    const input = readFileSync(sourcePath, 'utf8')
      .replace(/(['"])(\.\.?\/[^'"]+)\1/g, (_, quote, specifier) => JSON.stringify(resolve(dirname(sourcePath), specifier)));
    expect(input).toContain(header);
    // Hooks after a file run in reverse registration order, so a wait registered
    // before the suite's own teardown hook runs after it: it observes the body's
    // settlement in the broken control too, where the suite's hooks do not wait.
    const settled = `afterAll(restoreSharpThreads);
afterAll(async () => {
  const { existsSync } = await import('node:fs');
  await vi.waitFor(() => expect(existsSync(${JSON.stringify(finished)})).toBe(true), { timeout: 5000 });
});`;
    expect(input).toContain('afterAll(restoreSharpThreads);');
    const source = input.replace('afterAll(restoreSharpThreads);', settled).replace(header, `${header.replace('async () =>', 'async ({ signal }) =>')}
    const { writeFileSync } = await import('node:fs');
    const cancelled = new Promise(resolve => signal.addEventListener('abort', () => setImmediate(resolve), { once: true }));
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    await cancelled;
    await records.createRecord({ kind: 'character', name: 'Interrupted' }, 'interrupted-walker');
    writeFileSync(${JSON.stringify(finished)}, 'finished');
    return;`);
    expect(source).toContain('await cancelled;');
    writeFileSync(join(fixture, 'lifecycle.test.js'), source);
    writeFileSync(join(fixture, 'failure.test.js'), fixtureReadyFailureSource(ready));
    args[args.indexOf('--maxWorkers') + 1] = '2';
    args.push('--bail=1', '--testNamePattern', `${targetName}|controlled sibling failure`);
    const result = await runFixtureToCompletion(fixtureRun, RUN_CEILING_MS);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(output).toContain('controlled sibling failure');
    expect(existsSync(finished), output).toBe(true);
    expect(output).not.toMatch(/ENOTEMPTY|ENOENT|Unhandled|test temp leak:/);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}, RUN_CEILING_MS + 15000);
