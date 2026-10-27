import { afterAll, expect, it as vitestIt } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownTestBodies } from '../server/lib/mockPathsDataRoot.js';
import { createVitestTempFixture, fixtureReadyFailureSource, runFixtureToCompletion } from './lib/vitestTempRootFixture.js';

const owned = ownTestBodies(vitestIt);
afterAll(() => owned.drain());
const name = 'retires a cache whose former per-file metadata exceeds 16 MiB with bounded streaming proof';

// Cancel the actual long-running case with a neighboring fail-fast worker at
// two distinct boundaries. The synthetic proof fixture is small: the original
// 80,000-entry case still tests its full production budget independently.
for (const stage of ['creation', 'proof']) {
  owned.it(`held checkout fixture settles safely after sibling bail during ${stage}`, async ({ signal }) => {
    const host = mkdtempSync(join(tmpdir(), 'held-checkout-cancel-'));
    let closeConfirmed = true;
    try {
      const fixture = join(host, 'fixture');
      const ready = join(fixture, 'ready');
      const continued = join(fixture, 'continued-after-cancel');
      const run = createVitestTempFixture(host, 'server', '');
      writeFileSync(join(fixture, 'vitest.setup.js'), `import ${JSON.stringify(new URL('../server/vitest.setup.js', import.meta.url).href)};\n`);
      const sourcePath = fileURLToPath(new URL('../server/services/heldCheckoutRecovery.test.js', import.meta.url));
      const input = readFileSync(sourcePath, 'utf8');
      const header = `it('${name}', async ({ signal }) => {`;
      expect(input).toContain(header);
      let source = input.replace("import { existsSync, realpathSync } from 'fs';", "import { existsSync, realpathSync, writeFileSync } from 'fs';");
      const awaitBail = `writeFileSync(${JSON.stringify(ready)}, 'ready');
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));`;
      if (stage === 'creation') {
        const marker = '    for (let offset = 0; offset < count; offset += 32) {';
        expect(source).toContain(marker);
        source = source.replace(marker, `    ${awaitBail}\n${marker}`);
        const entry = "        const name = (offset + index).toString(16).padStart(64, '0');";
        expect(source).toContain(entry);
        source = source.replace(entry, `        if (signal.aborted) { writeFileSync(${JSON.stringify(continued)}, 'continued'); throw new Error('fixture created entries after cancellation'); }\n${entry}`);
      } else {
        expect(source).toContain('    const count = 80000;');
        source = source.replace('    const count = 80000;', '    const count = 32;')
          .replace('    expect(oldMetadataBytes).toBeGreaterThan(16 * 1024 * 1024);', '    expect(oldMetadataBytes).toBeGreaterThan(0);');
        const open = '    cacheFaults.onOpen = () => { if (++opened % 1024 === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); };';
        expect(source).toContain(open);
        source = source.replace(open, `    cacheFaults.onOpen = async () => {
          opened++;
          if (opened === 1) { ${awaitBail} }
          else if (signal.aborted) { writeFileSync(${JSON.stringify(continued)}, 'continued'); throw new Error('cache proof continued after cancellation'); }
          if (opened % 1024 === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        };`);
      }
      source = source.replace(/(['"])(\.\.?\/[^'"]+)\1/g, (_, _quote, specifier) => JSON.stringify(resolve(dirname(sourcePath), specifier)));
      writeFileSync(join(fixture, 'lifecycle.test.js'), source);
      writeFileSync(join(fixture, 'failure.test.js'), fixtureReadyFailureSource(ready));
      run.args[run.args.indexOf('--maxWorkers') + 1] = '2';
      run.args.push('--bail=1', '--testNamePattern', `${name}|controlled sibling failure`);
      closeConfirmed = false;
      const result = await runFixtureToCompletion(run, 120000, { signal });
      closeConfirmed = result.closeConfirmed;
      if (signal.aborted && closeConfirmed) return;
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(1);
      expect(output).toContain('controlled sibling failure');
      expect(existsSync(ready), output).toBe(true);
      expect(existsSync(continued), output).toBe(false);
      expect(output).not.toMatch(/Hook timed out|test temp leak:|ENOTEMPTY|Unhandled/);
    } finally {
      if (closeConfirmed) rmSync(host, { recursive: true, force: true });
    }
  }, 135000);
}
