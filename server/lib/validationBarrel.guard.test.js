import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// #16559: keep new schemas out of the catch-all barrel. Compatibility
// re-exports do not raise the ceiling and should not pull its closure into callers.
describe('validation.js stays a shrinking compatibility barrel', () => {
  const barrelPath = fileURLToPath(new URL('./validation.js', import.meta.url));
  const barrelSrc = readFileSync(barrelPath, 'utf8');
  const ownExportCeiling = 266;
  const ownExportNames = (src) => {
    const names = new Set([...src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)]
      .map((match) => match[1]));
    for (const [, list] of src.matchAll(/^export\s*\{([^}]*)\}\s*(?:;|$)/gm)) {
      for (const part of list.split(',').map((name) => name.trim()).filter(Boolean)) {
        names.add(part.split(/\s+as\s+/).pop().trim());
      }
    }
    return names;
  };
  const ownNames = ownExportNames(barrelSrc);

  it(`declares at most ${ownExportCeiling} own exports`, () => {
    expect(ownNames.size, 'Put new schemas in their domain validation modules and ratchet the ceiling down after moving exports.')
      .toBeLessThanOrEqual(ownExportCeiling);
  });

  it('distinguishes own exports from compatibility re-exports', async () => {
    const validation = await import('./validation.js');
    for (const name of ownNames) expect(validation).toHaveProperty(name);
    expect(ownNames.has('appIconQuerySchema')).toBe(true);
    expect(ownNames.has('optionalBooleanMap')).toBe(true);
    expect(ownNames.has('validateRequest')).toBe(false);
    expect(ownExportNames(`${barrelSrc}\nexport const plantedSchema = z.string();\n`).size).toBe(ownNames.size + 1);
  });

  it('imports re-exports from their declaring modules when the barrel is otherwise unused', () => {
    const candidates = execFileSync('git', ['grep', '-l', '-z', '-F', 'validation.js', '--', 'server/**/*.js', 'server/**/*.jsx'], {
      cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true,
    }).split('\0').filter(Boolean);
    const offenders = [];
    for (const file of candidates) {
      const fullPath = join(REPO_ROOT, file);
      const src = readFileSync(fullPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const [, bindings, , specifier] of src.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*(['"])([^'"\n]+)\2/g)) {
        if (!specifier.startsWith('.') || resolve(dirname(fullPath), specifier) !== barrelPath) continue;
        const names = bindings.split(',').map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        const validatorOnly = names.length === 1 && names[0] === 'validateRequest';
        const reExportsOnly = names.length && !names.some((name) => ownNames.has(name));
        if (validatorOnly || (reExportsOnly && !/\.test\.jsx?$/.test(file))) offenders.push(`${file}: ${names.join(', ')}`);
      }
    }
    expect(offenders, 'Import these names from validateRequest.js or the declaring domain validation module.').toEqual([]);
  });
});
