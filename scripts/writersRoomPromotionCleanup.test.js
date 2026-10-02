import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVitestTempFixture } from './lib/vitestTempRootFixture.js';

// Pins the regression uniquely: a different worker's --bail=1 failure cancels
// the promotion test while its body still owns an asynchronous persistence call.
it('drains promotion fixture writes after another worker triggers fail-fast', () => {
  const host = mkdtempSync(join(tmpdir(), 'wr-cancel-'));
  try {
    const fixture = join(host, 'fixture');
    const ready = join(fixture, 'ready');
    const finished = join(fixture, 'finished');
    const { args, options } = createVitestTempFixture(host, 'server', '');
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
        await expect.poll(() => existsSync(${JSON.stringify(finished)}), { timeout: 1000 }).toBe(true);
      });
    `);
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
    expect(output).not.toContain('test temp leak:');
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
}, 25000);
