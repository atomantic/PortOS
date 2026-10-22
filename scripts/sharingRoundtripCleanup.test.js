import { afterAll, expect, it as vitestIt } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
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

// A sibling fails only once an actual export reaches its first bucket write.
// The cancelled body must finish its original round-trip assertions before
// teardown removes its bucket; otherwise atomicWrite recreates that bucket.
it('settles sharing round-trip writes before fail-fast fixture cleanup', async ({ signal }) => {
  const host = mkdtempSync(join(tmpdir(), 'sharing-cancel-'));
  try {
    const fixture = join(host, 'fixture');
    const ready = join(fixture, 'ready');
    const events = join(fixture, 'events');
    const finished = join(fixture, 'finished');
    const fixtureRun = createVitestTempFixture(host, 'server', '');
    const { args } = fixtureRun;
    const sourcePath = fileURLToPath(new URL('../server/services/sharing/integration.test.js', import.meta.url));
    const header = "it('exports a series, processes the manifest as inbox, then promotes — id + origin preserved', async () => {";
    const end = "expect(await importer.listInbox(bucket.id)).toEqual([]);";
    const input = readFileSync(sourcePath, 'utf8')
      .replace(/(['"])(\.\.?\/[^'"]+)\1/g, (_, quote, specifier) => JSON.stringify(resolve(dirname(sourcePath), specifier)));
    const start = input.indexOf(header);
    expect(start).toBeGreaterThanOrEqual(0);
    const stop = input.indexOf('\n  });', start + header.length);
    expect(stop).toBeGreaterThan(start);
    const selected = input.slice(start, stop);
    expect(selected).toContain(end);
    // Bound both substitutions to the selected top-level test body. Other
    // round trips can have the same assertion without receiving its finally.
    const source = input.slice(0, start) + selected
      .replace(header, `${header.replace('async () =>', 'async ({ signal }) =>')}
        const { appendFileSync } = await import('node:fs');
        const record = event => appendFileSync(${JSON.stringify(events)}, event + '\\n');
        const cancelled = new Promise(resolve => signal.addEventListener('abort', () => setImmediate(resolve), { once: true }));
        let paused = false;
        fileUtilsMock.atomicWrite.mockImplementation(async (...args) => {
          if (!paused && args[0].startsWith(tempBucket)) {
            paused = true;
            record('export-write-ready');
            writeFileSync(${JSON.stringify(ready)}, 'ready');
            await cancelled;
            record('bucket-at-resume:' + existsSync(tempBucket));
            await fileUtilsMock.realAtomicWrite(...args);
            record('bucket-after-write:' + existsSync(tempBucket));
            return;
          }
          return fileUtilsMock.realAtomicWrite(...args);
        });
        try {`)
      .replace(end, `${end}
          record('round-trip-assertions-complete');
        } finally {
          record('body-settled');
          writeFileSync(${JSON.stringify(finished)}, 'finished');
        }`) + input.slice(stop);
    expect(source).toContain('await cancelled;');
    expect(source).toContain("record('round-trip-assertions-complete');");
    writeFileSync(join(fixture, 'lifecycle.test.js'), source + `
      afterAll(async () => {
        // Observe settlement before global leak accounting even in the broken
        // control, where the fixture's own hooks fail to wait for the body.
        await vi.waitFor(() => expect(existsSync(${JSON.stringify(finished)})).toBe(true), { timeout: 1000 });
      });
    `);
    writeFileSync(join(fixture, 'failure.test.js'), fixtureReadyFailureSource(ready));
    args[args.indexOf('--maxWorkers') + 1] = '2';
    args.push('--bail=1', '--testNamePattern', 'exports a series, processes the manifest|controlled sibling failure');
    // The nested run is bounded by its lifecycle, not a short fixed clock: a cold
    // import graph under full-suite load can outlast a 20s spawnSync deadline, which
    // reported ETIMEDOUT with no phase. Phase files are named in any failure.
    const result = await runFixtureToCompletion(fixtureRun, RUN_CEILING_MS, { signal });
    if (signal.aborted) return;
    const phases = ['ready', 'finished'].map(name => `${name}=${existsSync(join(fixture, name))}`).join(' ');
    const output = `${result.stdout}\n${result.stderr}\nlifecycle phases: ${phases}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(output).toContain('controlled sibling failure');
    const observed = existsSync(events) ? readFileSync(events, 'utf8') : '';
    expect(observed, output).toBe('export-write-ready\nbucket-at-resume:true\nbucket-after-write:true\nround-trip-assertions-complete\nbody-settled\n');
    expect(output).not.toMatch(/ENOTEMPTY|ENOENT|Unhandled|test temp leak:/);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}, RUN_CEILING_MS + 15000);
