import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVitestTempFixture, fixtureReadyFailureSource } from './lib/vitestTempRootFixture.js';

// A sibling fails only once an actual export reaches its first bucket write.
// The cancelled body must finish its original round-trip assertions before
// teardown removes its bucket; otherwise atomicWrite recreates that bucket.
it('settles sharing round-trip writes before fail-fast fixture cleanup', () => {
  const host = mkdtempSync(join(tmpdir(), 'sharing-cancel-'));
  try {
    const fixture = join(host, 'fixture');
    const ready = join(fixture, 'ready');
    const events = join(fixture, 'events');
    const finished = join(fixture, 'finished');
    const { args, options } = createVitestTempFixture(host, 'server', '');
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
    const result = spawnSync(process.execPath, args, options);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(output).toContain('controlled sibling failure');
    const observed = readFileSync(events, 'utf8');
    expect(observed, output).toBe('export-write-ready\nbucket-at-resume:true\nbucket-after-write:true\nround-trip-assertions-complete\nbody-settled\n');
    expect(output).not.toMatch(/ENOTEMPTY|ENOENT|Unhandled|test temp leak:/);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}, 25000);
