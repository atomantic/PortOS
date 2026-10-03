import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVitestTempFixture } from './lib/vitestTempRootFixture.js';

// Pins the regression uniquely: a different worker's --bail=1 failure cancels a
// duplicate-detection test while its body still owns store writes into the
// fixture root, which the suite's teardown must not remove underneath it.
it('drains duplicate-detection fixture writes after another worker triggers fail-fast', () => {
  const host = mkdtempSync(join(tmpdir(), 'dd-cancel-'));
  try {
    const fixture = join(host, 'fixture');
    const ready = join(fixture, 'ready');
    const finished = join(fixture, 'finished');
    const { args, options } = createVitestTempFixture(host, 'server', '');
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
    writeFileSync(join(fixture, 'failure.test.js'), `
      import { it, expect } from 'vitest';
      import { existsSync } from 'node:fs';
      it('controlled sibling failure', async () => {
        await expect.poll(() => existsSync(${JSON.stringify(ready)}), { timeout: 10000 }).toBe(true);
        throw new Error('controlled sibling failure');
      });
    `);
    const workerIndex = args.indexOf('--maxWorkers');
    args[workerIndex + 1] = '2';
    args.push('--bail=1');
    const result = spawnSync(process.execPath, args, options);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(output).toContain('controlled sibling failure');
    expect(existsSync(finished), output).toBe(true);
    expect(output).not.toMatch(/ENOTEMPTY|ENOENT|Unhandled|test temp leak:/);
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}, 25000);
