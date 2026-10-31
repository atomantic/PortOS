/**
 * The import-case guard catches the one Linux-only module failure a
 * case-insensitive filesystem (a macOS pregate run) cannot see. It must flag a specifier that
 * matches a tracked path only by case, in every import shape, and leave alone
 * both exact matches and paths git does not track at all.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkImportCase, importCaseMismatches, relativeSpecifiers } from './check-import-case.js';

const tracked = new Set(['src/Foo.js', 'src/lib/index.js', 'src/util/Helpers.jsx', 'src/data.json']);

describe('relativeSpecifiers', () => {
  it('collects static, dynamic-literal and import.meta.url specifiers, relative ones only, without query strings', () => {
    const source = [
      "import a from './Foo.js';",
      "export { b } from '../lib';",
      "import 'side-effect-package';",
      "const c = await import('./util/Helpers.jsx?raw');",
      "const d = new URL('./data.json', import.meta.url);",
      "// import x from './Commented.js'",
      "/* import y from './Blocked.js' */",
      "import z from 'zod';",
    ].join('\n');
    expect(relativeSpecifiers(source)).toEqual(['./Foo.js', '../lib', './util/Helpers.jsx', './data.json']);
  });
});

describe('relativeSpecifiers ignores non-executable text', () => {
  it('skips specifier-shaped text inside strings, template literals and regex literals but keeps template expressions', () => {
    const source = [
      'const a = "import(\x27./InString.js\x27)";',
      "const b = 'new URL(\"./InUrl.js\", import.meta.url)';",
      "const c = `import('./InTemplate.js')\nimport x from './TemplateStatic.js';`;",
      "const d = /import\\('.\\/InRegex.js'\\)/;",
      "const e = `${await import('./InExpression.js')}`;",
      "const f = 4 / 2; const g = await import('./Real.js');",
      "const h = '/* not a comment'; const i = await import('./AfterString.js');",
    ].join('\n');
    expect(relativeSpecifiers(source)).toEqual(['./InExpression.js', './Real.js', './AfterString.js']);
  });

  it('reads a leading regex in a template interpolation as a regex, and a closed template as an operand', () => {
    const source = [
      "const t = `${/x'/.test(s) ? import('./LeadingRegex.js') : null}`;",
      "const u = `a` / 2; await import('./AfterTemplate.js');",
    ].join('\n');
    expect(relativeSpecifiers(source)).toEqual(['./LeadingRegex.js', './AfterTemplate.js']);
  });

  it("treats division after postfix ++/-- and closing tokens as division, so later imports stay checked", () => {
    const source = [
      "const r1 = count++ / divisor; await import('./AfterInc.js');",
      "const r2 = count-- / divisor; await import('./AfterDec.js');",
      "const r3 = (a + b) / 2; await import('./AfterParen.js');",
      "const r4 = list[0] / 2; await import('./AfterBracket.js');",
      "const r5 = a + /x/.source.length; await import('./AfterRegex.js');",
    ].join("\n");
    expect(relativeSpecifiers(source)).toEqual(['./AfterInc.js', './AfterDec.js', './AfterParen.js', './AfterBracket.js', './AfterRegex.js']);
  });

  it('treats division after an object literal or function expression as division', () => {
    const source = [
      "const ratio = {} / divisor; await import('./AfterObject.js');",
      "const half = function () {} / 2; await import('./AfterFunction.js');",
    ].join('\n');
    expect(relativeSpecifiers(source)).toEqual(['./AfterObject.js', './AfterFunction.js']);
  });

  it('treats a slash after return/typeof/case-style keywords or a control header as a regex literal', () => {
    const source = [
      "function f() { return /\\//; } await import('./AfterReturn.js');",
      "const t = typeof /x'/; await import('./AfterTypeof.js');",
      "if (ok) /[/]'/.test(s); await import('./AfterIf.js');",
      "const q = obj.return / 2; await import('./AfterProp.js');",
      "const w = (a) / 2; await import('./AfterGroup.js');",
      "const of = 4; const r = of / 2; await import('./AfterOf.js');",
    ].join('\n');
    expect(relativeSpecifiers(source)).toEqual(['./AfterReturn.js', './AfterTypeof.js', './AfterIf.js', './AfterProp.js', './AfterGroup.js', './AfterOf.js']);
  });
});

describe('importCaseMismatches', () => {
  it('flags a case-only mismatch in each import shape and resolves extension and index completions', () => {
    const source = "import a from './foo.js';\nconst b = import('./util/helpers');\nconst c = new URL('./DATA.json', import.meta.url);\nimport d from './lib';";
    expect(importCaseMismatches('src/entry.js', source, tracked)).toEqual([
      { file: 'src/entry.js', specifier: './foo.js', resolved: 'src/foo.js', tracked: 'src/Foo.js' },
      { file: 'src/entry.js', specifier: './util/helpers', resolved: 'src/util/helpers', tracked: 'src/util/Helpers.jsx' },
      { file: 'src/entry.js', specifier: './DATA.json', resolved: 'src/DATA.json', tracked: 'src/data.json' },
    ]);
  });

  it('passes exact spellings and ignores specifiers git does not track at all', () => {
    const source = "import a from './Foo.js';\nimport b from './lib';\nimport c from './util/Helpers';\nimport d from './generated/manifest.js';\nimport e from '../../outside.js';";
    expect(importCaseMismatches('src/entry.js', source, tracked)).toEqual([]);
  });
});

describe('checkImportCase against a repository', () => {
  it('checks only the modules changed since the base, and every tracked module without one', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-import-case-'));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Example', '-c', 'user.email=ci@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
    const write = (path, body) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    };
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'core.hooksPath', join(root, 'empty-hooks'));
      write('src/Foo.js', 'export const foo = 1;\n');
      write('src/old.js', "import { foo } from './foo.js';\n");
      git('add', '--all');
      git('commit', '-qm', 'base with a latent mismatch');
      const base = git('rev-parse', 'HEAD');
      write('src/new.js', "import { foo } from './Foo.js';\nexport const bar = foo;\n");
      git('add', '--all');
      git('commit', '-qm', 'clean addition');
      // Only the new module is examined against the base: the latent mismatch
      // in an untouched file is not this pull request's to answer for.
      expect(checkImportCase({ cwd: root, baseSha: base })).toEqual({ checked: 1, mismatches: [] });
      // Without a base every tracked module is examined.
      const whole = checkImportCase({ cwd: root });
      expect(whole.checked).toBe(3);
      expect(whole.mismatches).toEqual([{ file: 'src/old.js', specifier: './foo.js', resolved: 'src/foo.js', tracked: 'src/Foo.js' }]);
      // A changed module with the mismatch fails the scoped check.
      write('src/new.js', "import { foo } from './foo.js';\n");
      git('commit', '-qam', 'regress');
      expect(checkImportCase({ cwd: root, baseSha: base }).mismatches.map((m) => m.file)).toEqual(['src/new.js']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is wired into the impact job before the planner runs', () => {
    const workflow = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'ci.yml'), 'utf8');
    const impact = workflow.slice(workflow.indexOf('\n  impact:\n'), workflow.indexOf('\n  prompt-history:\n'));
    expect(impact).toContain('run: node scripts/ci-impact-diagnostics.js import-case -- node scripts/check-import-case.js');
    expect(impact.indexOf('node scripts/check-import-case.js')).toBeLessThan(impact.indexOf('node scripts/ci-test-plan.js'));
  });
});
