import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./complexity-report.js', import.meta.url));
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'complexity-report-'));
  tempDirs.push(dir);
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '--quiet'], { cwd: dir });
  const write = (path, content) => {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const run = () => spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
  return { dir, write, run };
}

it('ranks classic complexity deterministically, isolates nested functions, and separates tests from source', () => {
  const { dir, write, run } = fixtureRepo();
  const branching = `/* eslint complexity: off */
export function branching(a, b = 1) {
  if (a && b) { for (const n of a) { if (n) return n; } }
  switch (b) { case 1: return 1; case 2: return 2; default: return 0; }
}
export function outer(a) {
  function inner(b) { if (b) return 1; if (b === 2) return 2; }
  if (a) return inner(a);
}
export function operators(a, b) {
  try { return a?.foo && (a.foo ?? b) ? 1 : 0; } catch { return 0; }
}
`;
  write('src/zeta.js', branching);
  write('src/alpha.js', branching);
  write('src/view.jsx', 'export const View = ({ value }) => value ? <span /> : null;');
  write('src/common.cjs', 'module.exports = function common(value) { return value || 0; };');
  write('src/many.js', Array.from({ length: 25 }, (_, i) => `export function spare${i}() {}`).join('\n'));
  write('src/widget.test.js', Array.from({ length: 8 }, (_, i) => `function test${i}(v) { if (v) return v; }`).join('\n'));
  write('tests/helpers.js', 'export function helper(x) { if (x) return x; }');
  for (const path of ['vendor/skip.js', 'server/lib/aiToolkit/skip.js', 'dist/skip.js', 'src/generated/skip.js', 'src/code.generated.js', 'scripts/migrations/skip.js', 'ignored/skip.js']) {
    write(path, 'export function mustNotAppear(a) { if (a) return a; }');
  }
  write('.gitignore', 'ignored/\n');
  write('src/deleted.js', 'export function deleted() {}');
  execFileSync('git', ['add', 'src/alpha.js', 'src/deleted.js'], { cwd: dir });
  rmSync(join(dir, 'src/deleted.js'));

  const first = run();
  const second = run();
  expect(first.status).toBe(0);
  expect(first.stderr).toBe('');
  expect(second.stdout).toBe(first.stdout);
  expect(first.stdout).toContain('classic variant');
  expect(first.stdout).toContain('Other languages are not scanned');
  const [source, tests] = first.stdout.split('Tests and fixtures:');
  expect(source).toContain('Source: 5/5 files scanned');
  expect(source).toMatch(/8\s+src\/alpha\.js:2:\d+\s+Function 'branching'/);
  expect(source.indexOf('src/alpha.js:2:')).toBeLessThan(source.indexOf('src/zeta.js:2:'));
  expect(source).toMatch(/6\s+src\/alpha\.js:10:\d+\s+Function 'operators'/);
  expect(source).toMatch(/3\s+src\/alpha\.js:7:\d+\s+Function 'inner'/);
  expect(source).toMatch(/2\s+src\/alpha\.js:6:\d+\s+Function 'outer'/);
  expect(source).toContain('src/view.jsx');
  expect(source).toContain('src/common.cjs');
  expect(source).not.toContain('widget.test.js');
  expect(tests).toContain('src/widget.test.js');
  expect(source.match(/^\s+\d+\s+/gm)).toHaveLength(20);
  expect(tests.match(/^\s+\d+\s+/gm)).toHaveLength(5);
  expect(first.stdout).not.toMatch(/mustNotAppear|deleted\.js/);
});

it('reports syntax errors as an incomplete scan while retaining the valid shortlist', () => {
  const { write, run } = fixtureRepo();
  write('src/good.js', 'export function good(a) { if (a) return a; }');
  write('src/broken.js', 'export function broken( {');
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('Source: 1/2 files scanned');
  expect(result.stdout).toContain('src/good.js');
  expect(result.stderr).toMatch(/Scan incomplete: 1 error\(s\)/);
  expect(result.stderr).toMatch(/src\/broken\.js:1:\d+ Parsing error:/);
});
