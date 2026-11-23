import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSearchDirs, discoverServicesDirs, exportedNames, moduleSummary, searchCatalog, summaryProblems, SUMMARY_MAX } from './lib-catalog.js';

const SCRIPT = fileURLToPath(new URL('./lib-catalog.js', import.meta.url));

describe('moduleSummary', () => {
  it.each([
    ['a JSDoc block, stopping at the first blank line', '/**\n * Does one thing\n * well.\n *\n * Rationale.\n */\nexport const a = 1;\n', 'Does one thing well.'],
    ['text on the opening line of a block', '/** Inline summary. */\nexport const a = 1;\n', 'Inline summary.'],
    ['a line-comment run', '// First line\n// continues.\n//\n// Rationale.\nimport x from "y";\n', 'First line continues.'],
    ['a block that stops at a JSDoc tag', '/**\n * Summary.\n * @param {string} a\n */\n', 'Summary.'],
    ['a header after a shebang and tool directives', `#!/usr/bin/env node\n// @${'vitest'}-environment node\n\n// Real summary.\n`, 'Real summary.'],
    ['a file with no leading comment', 'import x from "y";\n// later comment\n', ''],
    ['an empty header', '/**\n *\n */\nexport {};\n', ''],
  ])('reads %s', (_label, source, expected) => {
    expect(moduleSummary(source)).toBe(expected);
  });
});

it('lists declared, re-exported, aliased and default exports once each', () => {
  const source = [
    'export async function load() {}',
    'export const A = 1, B = 2;',
    'export class Store {}',
    'export { a, b as renamed };',
    "export * as ns from './ns.js';",
    "export * from './flat.js';",
    'export default load;',
    'export const A2 = A;',
  ].join('\n');
  expect(exportedNames(source)).toEqual(['load', 'A', 'Store', 'A2', 'default', 'a', 'renamed', 'ns', '* from ./flat.js']);
});

describe('catalog over a directory', () => {
  const withTree = (files, fn) => {
    const root = mkdtempSync(join(tmpdir(), 'lib-catalog-'));
    try {
      mkdirSync(join(root, 'server/lib'), { recursive: true });
      for (const [name, body] of Object.entries(files)) writeFileSync(join(root, 'server/lib', name), body);
      return fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('reports missing and over-length summaries but ignores tests', () => withTree({
    'good.js': '// Fine.\nexport const good = 1;\n',
    'bare.js': 'export const bare = 1;\n',
    'long.js': `// ${'x'.repeat(SUMMARY_MAX + 1)}\nexport const long = 1;\n`,
    'bare.test.js': 'export {};\n',
  }, (root) => {
    const problems = summaryProblems('server/lib', root);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^server\/lib\/bare\.js: missing header/);
    expect(problems[1]).toMatch(new RegExp(`^server/lib/long\\.js: summary is ${SUMMARY_MAX + 1} chars`));
  }));

  it('matches every term against path, exports and the whole header', () => withTree({
    'alpha.js': '/**\n * Alpha summary.\n *\n * Mentions retries deep in the rationale.\n */\nexport const runAlpha = 1;\n',
    'beta.js': '// Beta summary.\nexport const runBeta = 1;\n',
  }, (root) => {
    const paths = (terms) => searchCatalog(terms, { dirs: ['server/lib'], root }).map((entry) => entry.path);
    expect(paths(['RETRIES'])).toEqual(['server/lib/alpha.js']);
    expect(paths(['run'])).toEqual(['server/lib/alpha.js', 'server/lib/beta.js']);
    expect(paths(['run', 'beta'])).toEqual(['server/lib/beta.js']);
  }));
});

it('prints `path — summary — exports` from the CLI and exits 1 on no match', () => {
  const found = spawnSync(process.execPath, [SCRIPT, 'libCatalogCliProbe-no-such-term'], { encoding: 'utf8' });
  expect(found.status).toBe(1);
  expect(found.stdout).toBe('');
  const hit = spawnSync(process.execPath, [SCRIPT, 'abortTimeout', '--dir', 'server/lib'], { encoding: 'utf8' });
  expect(hit.status, hit.stderr).toBe(0);
  expect(hit.stdout).toMatch(/^server\/lib\/abortTimeout\.js — .+ — .*withAbortTimeout/m);
  const bad = spawnSync(process.execPath, [SCRIPT, 'x', '--dir', 'server/nope'], { encoding: 'utf8' });
  expect(bad.status).toBe(2);
  const noFlag = spawnSync(process.execPath, [SCRIPT, 'x', '--dir', 'server/services'], { encoding: 'utf8' });
  expect(noFlag.status).toBe(2);
});

describe('auto-discovery', () => {
  const dirs = discoverSearchDirs();

  it('walks nested server/lib dirs and scripts/lib but skips vendored and fixture dirs', () => {
    expect(dirs).toEqual(expect.arrayContaining([
      'server/lib', 'server/lib/editorial', 'server/lib/db/schema', 'server/lib/agentGuard',
      'server/lib/skills', 'server/lib/aiToolkit', 'scripts/lib', 'client/src/hooks',
    ]));
    expect(dirs).not.toContain('server/lib/aiToolkit/internal');
    expect(dirs.some((dir) => /(^|\/)(fixtures|__fixtures__|node_modules)(\/|$)/.test(dir))).toBe(false);
    expect(dirs.some((dir) => dir.startsWith('server/services'))).toBe(false);
  });

  it('finds modules in nested dirs and scripts/lib from the CLI', () => {
    const hit = spawnSync(process.execPath, [SCRIPT, 'directInvocation'], { encoding: 'utf8' });
    expect(hit.status, hit.stderr).toBe(0);
    expect(hit.stdout).toMatch(/^scripts\/lib\/directInvocation\.js — /m);
    const nested = spawnSync(process.execPath, [SCRIPT, '', '--dir', 'server/lib/editorial'], { encoding: 'utf8' });
    expect(nested.status, nested.stderr).toBe(0);
    expect(nested.stdout).toMatch(/^server\/lib\/editorial\//m);
  });

  it('searches server/services only with --services', () => {
    expect(discoverServicesDirs()).toContain('server/services');
    const without = spawnSync(process.execPath, [SCRIPT, 'cos', '--dir', 'server/services'], { encoding: 'utf8' });
    expect(without.status).toBe(2);
    const withFlag = spawnSync(process.execPath, [SCRIPT, 'cos', '--services'], { encoding: 'utf8' });
    expect(withFlag.status, withFlag.stderr).toBe(0);
    expect(withFlag.stdout).toMatch(/^server\/services\//m);
    const scoped = spawnSync(process.execPath, [SCRIPT, 'cos', '--services', '--dir', 'server/services'], { encoding: 'utf8' });
    expect(scoped.status, scoped.stderr).toBe(0);
  });
});
