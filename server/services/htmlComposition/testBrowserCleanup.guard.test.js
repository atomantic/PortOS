import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Playwright's CDP adapter mints `playwright-artifacts-*` itself unless told
// otherwise, and removes it from a Disconnected listener nobody awaits (#11584).
describe('fixture-owned CDP artifacts root', () => {
  it('every server CDP fixture passes a fixture-owned artifacts root', () => {
    const unowned = source => [...source.matchAll(/chromium\.connectOverCDP\(/g)].filter(match => {
      let depth = 1;
      let end = match.index + match[0].length;
      for (; end < source.length && depth; end++) depth += source[end] === '(' ? 1 : source[end] === ')' ? -1 : 0;
      return !source.slice(match.index, end).includes('artifactsDir');
    }).length;
    expect(unowned('browser = await chromium.connectOverCDP(endpoint);')).toBe(1);
    expect(unowned('chromium.connectOverCDP(await wait(proc), { artifactsDir: artifacts.path })')).toBe(0);
    const server = fileURLToPath(new URL('../../', import.meta.url));
    const listed = spawnSync('git', ['grep', '-l', '-F', 'chromium.connectOverCDP(', '--', '*.test.js'], { cwd: server, encoding: 'utf8' });
    expect(listed.status).toBe(0);
    // This file's probe strings above are not fixtures.
    const files = listed.stdout.split('\n').filter(file => file && file !== 'services/htmlComposition/testBrowserCleanup.test.js');
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter(file => unowned(readFileSync(join(server, file), 'utf8')))).toEqual([]);
  });
});
